// V-CP-1 — a sub-agent that finishes its task through tools and then stops
// without a word is not a failure. The loop ends that turn with a blank `done`
// (settleTextEnd, packages/core/src/agent-loop/stages/text-end.ts), so
// delegate_task's `runSubAgent` returns instead of throwing, and the parent
// gets `ok: true`. Driven through a real AgentLoop.

import { AgentLoop, DefaultToolRegistry, InMemorySessionStore } from '@ethosagent/core';
import type { CompletionChunk, LLMProvider, Message, Tool, ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { createDelegateTaskTool } from '../index';

/** First call asks for `write_file`; the call after its result is silent. */
function silentChildLLM(): LLMProvider {
  return {
    name: 'scripted',
    model: 'scripted-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[]): AsyncIterable<CompletionChunk> {
      const last = messages.at(-1);
      const afterTool =
        last !== undefined &&
        typeof last.content !== 'string' &&
        JSON.stringify(last.content).includes('tool_result');
      if (!afterTool) {
        const args = JSON.stringify({ path: 'a.txt' });
        yield { type: 'tool_use_start', toolCallId: 'call-1', toolName: 'write_file' };
        yield { type: 'tool_use_delta', toolCallId: 'call-1', partialJson: args };
        yield { type: 'tool_use_end', toolCallId: 'call-1', inputJson: args };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function ctx(): ToolContext {
  return {
    sessionId: 'parent-session',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    agentId: 'depth:0',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  };
}

describe('delegate_task — a sub-agent that finished via tools (V-CP-1)', () => {
  it('returns ok, not "Sub-agent failed"', async () => {
    const writes: unknown[] = [];
    const writeFile: Tool = {
      name: 'write_file',
      description: 'write_file',
      schema: { type: 'object' },
      capabilities: {},
      async execute(args: unknown) {
        writes.push(args);
        return { ok: true, value: 'written' };
      },
    };
    const tools = new DefaultToolRegistry();
    tools.register(writeFile);
    const loop = new AgentLoop({
      llm: silentChildLLM(),
      tools,
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
      compaction: { autoCompact: false },
    });
    const result = await createDelegateTaskTool(loop).execute({ prompt: 'write a.txt' }, ctx());
    expect(writes).toEqual([{ path: 'a.txt' }]);
    expect(result.ok).toBe(true);
  });
});
