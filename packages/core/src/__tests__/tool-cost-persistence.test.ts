import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

// A tool that reports `cost_usd` (image generation, a vision call) spent real
// money. The stored figure behind `ethos usage`, the per-bot daily cap and web
// Usage is SUM(messages.estimated_cost_usd) (`SQLiteSessionStore.usageAggregate`),
// so the cost has to land on a message row, and the session rollup has to move
// with it or `rollup == SUM(messages)` breaks.

function oneToolCallLLM(): LLMProvider {
  let calls = 0;
  return {
    name: 'one-tool',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      calls++;
      const usage: CompletionChunk = {
        type: 'usage',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: 0.01,
        },
      };
      if (calls > 1) {
        yield { type: 'text_delta', text: 'done' };
        yield usage;
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      yield { type: 'tool_use_start', toolCallId: 'c1', toolName: 'paint' };
      yield { type: 'tool_use_end', toolCallId: 'c1', inputJson: '{}' };
      yield usage;
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}

describe('tool-reported cost_usd', () => {
  it('is persisted on the tool_result row and rolled into the session total', async () => {
    const tools = new DefaultToolRegistry();
    tools.register({
      name: 'paint',
      description: 'paint',
      schema: { type: 'object' },
      capabilities: {},
      execute: async () => ({ ok: true, value: 'painted', cost_usd: 0.25 }),
    });
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({
      llm: oneToolCallLLM(),
      tools,
      session,
      safety: createTestSafety(),
    });

    for await (const _ of loop.run('go', { sessionKey: 'tool-cost' })) {
      // drain
    }

    const s = await session.getSessionByKey('tool-cost');
    if (!s) throw new Error('session missing');
    const messages = await session.getMessages(s.id);
    const toolRow = messages.find((m) => m.role === 'tool_result');
    expect(toolRow?.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0.25,
    });

    const stored = messages.reduce((sum, m) => sum + (m.usage?.estimatedCostUsd ?? 0), 0);
    expect(stored).toBeCloseTo(0.27, 9);
    expect((await session.getSession(s.id))?.usage.estimatedCostUsd).toBeCloseTo(0.27, 9);
  });
});
