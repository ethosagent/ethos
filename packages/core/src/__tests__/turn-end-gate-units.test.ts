// The turn-end compaction gate uses the pre-LLM gate's whole-request units.
//
// The pre-LLM gate (`maybeCompact`) counts the tool schemas in both its usage
// estimate and its static slice. The turn-end trigger (`maybeConsolidateAtTurnEnd`)
// estimated usage from the system prompt and messages alone, while a measured
// static slice (system + tools) sat in its threshold — and with nothing measured
// it compared against `pressure × window` with the prefix counted as messages.
// Either way a session with large tool schemas compacted late at turn end.
// `evaluateGate` now takes the tool schemas and derives both sides from them, and
// the turn end passes the definitions the turn's LLM calls send
// (`turnToolDefinitions` over `TurnEndCtx.toolScope`).
//
// Pins: `evaluateGate` in `packages/core/src/agent-loop/compaction.ts` and the
// gate call in `maybeConsolidateAtTurnEnd` (`agent-loop/turn-end.ts`).

import type { CompletionChunk, LLMProvider, Message, Tool } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { effectiveGate, evaluateGate } from '../agent-loop/compaction';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

// 200k window (195,904 usable after the default 4,096 output reserve). ~40k
// tokens of tool schemas and ~110k tokens of older history: the pre-LLM gate
// (~40k + 0.8 × ~156k ≈ 165k) does not fire at assembly (~150k), so whether the
// turn END compacts is decided by the reply's size alone.
const WINDOW = 200_000;

const bigTool: Tool = {
  name: 'big_tool',
  description: 'd'.repeat(160_000),
  schema: { type: 'object' },
  capabilities: {},
  execute: async () => ({ ok: true, value: 'x' }),
};

interface Call {
  messages: Message[];
  system: string;
  tools: string;
}

function replyingLLM(reply: string, calls: Call[]): LLMProvider {
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: WINDOW,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages, tools, opts) {
      calls.push({
        messages: messages.slice(),
        system: opts?.system ?? '',
        tools: JSON.stringify(tools),
      });
      const chunks: CompletionChunk[] = [
        { type: 'text_delta', text: reply },
        // No usage reported: nothing measured, so both gates estimate.
        { type: 'done', finishReason: 'end_turn' },
      ];
      for (const c of chunks) yield c;
    },
    async countTokens() {
      return 10;
    },
  };
}

async function runTurn(replyChars: number) {
  const session = new InMemorySessionStore();
  const s = await session.createSession({
    key: 'cli:units',
    platform: 'cli',
    model: 'mock-model',
    provider: 'mock',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0,
      apiCallCount: 0,
      compactionCount: 0,
    },
  });
  for (let i = 0; i < 10; i++) {
    await session.appendMessage({ sessionId: s.id, role: 'user', content: `${i}`.repeat(44_000) });
    await session.appendMessage({ sessionId: s.id, role: 'assistant', content: `a${i}` });
  }
  const tools = new DefaultToolRegistry();
  tools.register(bigTool);
  const calls: Call[] = [];
  const reply = 'r'.repeat(replyChars);
  const loop = new AgentLoop({
    llm: replyingLLM(reply, calls),
    session,
    safety: createTestSafety(),
    tools,
  });
  const events: AgentEvent[] = [];
  for await (const e of loop.run('next', { sessionKey: 'cli:units' })) events.push(e);

  // What the pre-LLM gate would decide for the history the turn end sees: the
  // request the LLM just received plus the reply, with the same system prompt
  // and tool schemas.
  const call = calls[0];
  const after: Message[] = [...(call?.messages ?? []), { role: 'assistant', content: reply }];
  const g = evaluateGate(
    { llm: { maxContextTokens: WINDOW }, toolSchemas: call?.tools ?? '' },
    after,
    call?.system ?? '',
  );
  // The old turn-end arithmetic: no tool schemas on either side.
  const old = evaluateGate({ llm: { maxContextTokens: WINDOW } }, after, call?.system ?? '');
  return {
    calls,
    compacted: events.some((e) => e.type === 'tool_progress' && e.toolName === '_compaction'),
    compressions: await session.listCompressions(s.id),
    preLlmFires: g.current > effectiveGate(g, 0.8),
    oldFires: old.current > effectiveGate(old, 0.8),
    messages: await session.getMessages(s.id),
  };
}

describe('turn-end gate — the pre-LLM gate’s whole-request threshold', () => {
  it('compacts at turn end once the reply crosses the threshold that counts tool schemas', async () => {
    const r = await runTurn(80_000); // ~20k-token reply → ~170k
    expect(r.calls).toHaveLength(1); // the pre-LLM gate did not fire at assembly
    expect(r.preLlmFires).toBe(true);
    // Before: the estimate left the ~40k tokens of schemas out, so it did not fire.
    expect(r.oldFires).toBe(false);
    expect(r.compacted).toBe(r.preLlmFires);
    expect(r.compressions).toHaveLength(1);
    // The just-finished turn stays in the verbatim tail.
    const kept = r.compressions[0]?.keptFromMessageId;
    const keptAt = r.messages.findIndex((m) => m.id === kept);
    const lastUser = r.messages.map((m) => m.role).lastIndexOf('user');
    expect(keptAt).toBeGreaterThanOrEqual(0);
    expect(keptAt).toBeLessThanOrEqual(lastUser);
  });

  it('leaves a turn below that threshold alone', async () => {
    const r = await runTurn(20_000); // ~5k-token reply → ~155k
    expect(r.preLlmFires).toBe(false);
    expect(r.compacted).toBe(false);
    expect(r.compressions).toHaveLength(0);
  });
});
