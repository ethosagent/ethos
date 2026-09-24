// Containment 3b — the `before_tool_call` payload names the turn's personality.
// The web approval hook forwards it to the lease check, and a lease bound to
// one personality must not match a call from another.

import type {
  AgentEvent,
  BeforeToolCallPayload,
  CompletionChunk,
  LLMProvider,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultHookRegistry } from '../hook-registry';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

/** One `probe` call on the first round, plain text on the second. */
function scriptedLLM(): LLMProvider {
  let calls = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_use_start', toolCallId: 't1', toolName: 'probe' };
        yield { type: 'tool_use_end', toolCallId: 't1', inputJson: '{}' };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function probeTools(): DefaultToolRegistry {
  const tools = new DefaultToolRegistry();
  tools.register({
    name: 'probe',
    description: 'probe',
    schema: { type: 'object' },
    capabilities: {},
    async execute(): Promise<ToolResult> {
      return { ok: true, value: 'ok' };
    },
  });
  return tools;
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _e of gen) {
    // drain
  }
}

describe('before_tool_call payload', () => {
  it("carries the turn's personalityId", async () => {
    const seen: BeforeToolCallPayload[] = [];
    const hooks = new DefaultHookRegistry();
    hooks.registerModifying('before_tool_call', async (payload) => {
      seen.push(payload);
      return null;
    });
    const loop = new AgentLoop({
      llm: scriptedLLM(),
      tools: probeTools(),
      hooks,
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
    });

    await drain(loop.run('go', { sessionKey: 'cli:payload' }));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.personalityId).toBe('default');
  });
});
