// context_compression V1 + Q1 + Q2 — integration tests through AgentLoop.run().

import type { CompletionChunk, LLMProvider, Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { createTestSafety } from './helpers/test-safety';

const zeroUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

// Mock LLM that records the messages handed to each `complete()` call.
function makeCapturingLLM(captured: Message[][]): LLMProvider {
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[]): AsyncIterable<CompletionChunk> {
      captured.push(messages);
      yield { type: 'text_delta', text: 'ok' };
      yield {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: 0.0001,
        },
      };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 10;
    },
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function toolResultBlocks(messages: Message[]) {
  return messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b): b is Extract<typeof b, { type: 'tool_result' }> => b.type === 'tool_result');
}

describe('Q1 — tool-result dedup', () => {
  it('collapses identical repeated tool results to one full copy + placeholders', async () => {
    const session = new InMemorySessionStore();
    const s = await session.createSession({
      key: 'cli:dedup',
      platform: 'cli',
      model: 'mock-model',
      provider: 'mock',
      usage: { ...zeroUsage },
    });

    // The same file read five times across five turns — identical output.
    for (let i = 0; i < 5; i++) {
      await session.appendMessage({
        sessionId: s.id,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `tc${i}`, name: 'read_file', input: { path: '/a.txt' } }],
      });
      await session.appendMessage({
        sessionId: s.id,
        role: 'tool_result',
        toolCallId: `tc${i}`,
        toolName: 'read_file',
        content: 'FILE CONTENTS HERE',
      });
    }

    const captured: Message[][] = [];
    const loop = new AgentLoop({
      llm: makeCapturingLLM(captured),
      session,
      safety: createTestSafety(),
    });
    await collect(loop.run('continue', { sessionKey: 'cli:dedup' }));

    const blocks = toolResultBlocks(captured[0] ?? []);
    expect(blocks).toHaveLength(5);
    const full = blocks.filter((b) => b.content === 'FILE CONTENTS HERE');
    const deduped = blocks.filter((b) => b.content.startsWith('[deduped'));
    expect(full).toHaveLength(1);
    expect(deduped).toHaveLength(4);
    // The kept copy is the oldest; placeholders point backward at it.
    expect(blocks[0]?.content).toBe('FILE CONTENTS HERE');
    expect(deduped.every((b) => b.content.includes('tc0'))).toBe(true);
  });

  it('leaves distinct tool results untouched', async () => {
    const session = new InMemorySessionStore();
    const s = await session.createSession({
      key: 'cli:distinct',
      platform: 'cli',
      model: 'mock-model',
      provider: 'mock',
      usage: { ...zeroUsage },
    });
    for (let i = 0; i < 3; i++) {
      await session.appendMessage({
        sessionId: s.id,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `tc${i}`, name: 'read_file', input: { path: `/file${i}.txt` } }],
      });
      await session.appendMessage({
        sessionId: s.id,
        role: 'tool_result',
        toolCallId: `tc${i}`,
        toolName: 'read_file',
        content: `contents of file ${i}`,
      });
    }
    const captured: Message[][] = [];
    const loop = new AgentLoop({
      llm: makeCapturingLLM(captured),
      session,
      safety: createTestSafety(),
    });
    await collect(loop.run('continue', { sessionKey: 'cli:distinct' }));

    const blocks = toolResultBlocks(captured[0] ?? []);
    expect(blocks).toHaveLength(3);
    expect(blocks.every((b) => !b.content.startsWith('[deduped'))).toBe(true);
  });
});

describe('V1 + Q2 — compaction notice and anti-thrashing cooldown', () => {
  // Build a session over the 80% pressure gate (compaction fires) but under
  // the 95% hard-overflow gate (so the Q2 cooldown still applies). 200K
  // context → gate 160K / hard 190K; 4 chars/token → ~702K chars ≈ 175K tok.
  async function seedHeavySession(session: InMemorySessionStore, key: string) {
    const s = await session.createSession({
      key,
      platform: 'cli',
      model: 'mock-model',
      provider: 'mock',
      usage: { ...zeroUsage },
    });
    const big = 'x'.repeat(234_000);
    for (let i = 0; i < 3; i++) {
      await session.appendMessage({ sessionId: s.id, role: 'user', content: `turn ${i} ${big}` });
      await session.appendMessage({ sessionId: s.id, role: 'assistant', content: `reply ${i}` });
    }
    return s;
  }

  function compactionNotice(events: AgentEvent[]) {
    return events.find(
      (e): e is Extract<AgentEvent, { type: 'tool_progress' }> =>
        e.type === 'tool_progress' && e.toolName === '_compaction',
    );
  }

  it('V1 — emits a single _compaction notice on the turn compaction fires', async () => {
    const session = new InMemorySessionStore();
    await seedHeavySession(session, 'cli:notice');
    const captured: Message[][] = [];
    const loop = new AgentLoop({
      llm: makeCapturingLLM(captured),
      session,
      safety: createTestSafety(),
    });

    const events = await collect(loop.run('next', { sessionKey: 'cli:notice' }));
    const notices = events.filter(
      (e) => e.type === 'tool_progress' && e.toolName === '_compaction',
    );
    expect(notices).toHaveLength(1);
    const notice = compactionNotice(events);
    expect(notice?.audience).toBe('user');
    expect(notice?.message).toContain('compressed');
  });

  it('Q2 — cooldown suppresses a second compaction on the very next turn', async () => {
    const session = new InMemorySessionStore();
    await seedHeavySession(session, 'cli:cooldown');
    const captured: Message[][] = [];
    const loop = new AgentLoop({
      llm: makeCapturingLLM(captured),
      session,
      safety: createTestSafety(),
    });

    // Turn 1 — over pressure, never compacted before → compaction fires.
    const turn1 = await collect(loop.run('first', { sessionKey: 'cli:cooldown' }));
    expect(compactionNotice(turn1)).toBeDefined();

    // Turn 2 — still over pressure, but within the cooldown window → skipped.
    const turn2 = await collect(loop.run('second', { sessionKey: 'cli:cooldown' }));
    expect(compactionNotice(turn2)).toBeUndefined();
  });

  it('Q2 — hard overflow bypasses the cooldown so context never overruns', async () => {
    const session = new InMemorySessionStore();
    const s = await session.createSession({
      key: 'cli:overflow',
      platform: 'cli',
      model: 'mock-model',
      provider: 'mock',
      usage: { ...zeroUsage },
    });
    // ~225K tokens — past the 95% hard-overflow gate (190K).
    const huge = 'x'.repeat(300_000);
    for (let i = 0; i < 3; i++) {
      await session.appendMessage({ sessionId: s.id, role: 'user', content: `turn ${i} ${huge}` });
      await session.appendMessage({ sessionId: s.id, role: 'assistant', content: `reply ${i}` });
    }
    const captured: Message[][] = [];
    const loop = new AgentLoop({
      llm: makeCapturingLLM(captured),
      session,
      safety: createTestSafety(),
    });

    const turn1 = await collect(loop.run('first', { sessionKey: 'cli:overflow' }));
    expect(compactionNotice(turn1)).toBeDefined();
    // Within the cooldown window, but over the hard gate → compaction still fires.
    const turn2 = await collect(loop.run('second', { sessionKey: 'cli:overflow' }));
    expect(compactionNotice(turn2)).toBeDefined();
  });
});
