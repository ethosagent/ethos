// Phase 2 — compaction watermark read-back + manual /compact.
//
// Covers: the watermark is persisted and REPLAYED on the next turn (so the
// LLM sees `summary + tail`, never the raw prefix again — this is what makes
// the cooldown ship the compacted view); `/compact <focus>` text reaches the
// summarizer; and an unconfigured summarizer degrades to a drop-only compaction.

import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  StoredMessage,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import {
  computeKeptTailBoundary,
  reconstructFromWatermark,
  runManualCompaction,
  selectActiveWatermark,
} from '../agent-loop/manual-compact';
import type { SummarizerFn } from '../context-engines/semantic-summary';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { createTestSafety } from './helpers/test-safety';

function row(over: Partial<StoredMessage> & { id: string; role: StoredMessage['role'] }) {
  return {
    sessionId: 's',
    content: '',
    timestamp: new Date(),
    ...over,
  } as StoredMessage;
}

describe('watermark helpers', () => {
  it('selectActiveWatermark picks the latest row carrying a boundary', () => {
    const base = {
      originalCount: 0,
      keptCount: 0,
      summaryTokens: 0,
      preTotalTokens: 0,
      postTotalTokens: 0,
      durationMs: 0,
      engineName: 'x',
    };
    const rows = [
      {
        ...base,
        id: 'a',
        sessionId: 's',
        createdAt: new Date(1),
        keptFromMessageId: 'm1',
        summaryText: 'S1',
      },
      { ...base, id: 'b', sessionId: 's', createdAt: new Date(2) }, // no boundary
      {
        ...base,
        id: 'c',
        sessionId: 's',
        createdAt: new Date(3),
        keptFromMessageId: 'm2',
        summaryText: 'S2',
      },
    ];
    expect(selectActiveWatermark(rows)?.id).toBe('c');
    expect(selectActiveWatermark([])).toBeNull();
  });

  it('computeKeptTailBoundary never starts the tail on a tool_result', () => {
    const history = [
      row({ id: '0', role: 'user' }),
      row({ id: '1', role: 'assistant' }),
      row({ id: '2', role: 'assistant' }), // tool_use owner
      row({ id: '3', role: 'tool_result' }),
      row({ id: '4', role: 'tool_result' }),
    ];
    // tailKeep 2 → index 3 is a tool_result → walk back to its assistant (2).
    const { index, keptFromMessageId } = computeKeptTailBoundary(history, 2);
    expect(index).toBe(2);
    expect(keptFromMessageId).toBe('2');
  });

  it('walks back over MULTIPLE consecutive tool_result rows (depth > 1)', () => {
    const history = [
      row({ id: '0', role: 'user' }),
      row({ id: '1', role: 'assistant' }), // tool_use owner
      row({ id: '2', role: 'tool_result' }),
      row({ id: '3', role: 'tool_result' }),
    ];
    // tailKeep 1 → index 3 (tool_result) → walk back past index 2 (tool_result)
    // to the owning assistant at index 1. Exercises the multi-step walk-back.
    const { index, keptFromMessageId } = computeKeptTailBoundary(history, 1);
    expect(index).toBe(1);
    expect(keptFromMessageId).toBe('1');
  });

  it('reconstructFromWatermark replaces the prefix with the summary and keeps the tail', () => {
    const history = [
      row({ id: '0', role: 'user', content: 'OLD-0' }),
      row({ id: '1', role: 'assistant', content: 'OLD-1' }),
      row({ id: '2', role: 'user', content: 'KEEP-2' }),
      row({ id: '3', role: 'assistant', content: 'KEEP-3' }),
    ];
    const wm = {
      id: 'w1',
      sessionId: 's',
      createdAt: new Date(),
      engineName: 'semantic_summary',
      originalCount: 4,
      keptCount: 3,
      summaryText: 'THE SUMMARY',
      keptFromMessageId: '2',
      summaryTokens: 3,
      preTotalTokens: 0,
      postTotalTokens: 0,
      durationMs: 0,
    };
    const { history: out, applied } = reconstructFromWatermark(history, wm);
    expect(applied).toBe(true);
    expect(out).toHaveLength(3); // summary + KEEP-2 + KEEP-3
    expect(out[0]?.content).toContain('THE SUMMARY');
    expect(out.map((m) => m.content)).not.toContain('OLD-0');
    expect(out.map((m) => m.content)).toContain('KEEP-2');
  });

  it('reconstructFromWatermark drops the prefix (no summary) for drop-only watermarks', () => {
    const history = [
      row({ id: '0', role: 'user', content: 'OLD' }),
      row({ id: '1', role: 'user', content: 'KEEP' }),
    ];
    const wm = {
      id: 'w',
      sessionId: 's',
      createdAt: new Date(),
      engineName: 'drop_oldest',
      originalCount: 2,
      keptCount: 1,
      keptFromMessageId: '1',
      summaryTokens: 0,
      preTotalTokens: 0,
      postTotalTokens: 0,
      durationMs: 0,
    };
    const { history: out } = reconstructFromWatermark(history, wm);
    expect(out.map((m) => m.content)).toEqual(['KEEP']);
  });
});

describe('runManualCompaction', () => {
  function history(n: number): StoredMessage[] {
    return Array.from({ length: n }, (_, i) =>
      row({ id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: `MSG-${i}` }),
    );
  }

  it('threads /compact focus text into the summarizer', async () => {
    const seen: { instructions?: string } = {};
    const summarizer: SummarizerFn = async (_m, _t, instructions) => {
      seen.instructions = instructions;
      return 'summary';
    };
    const session = new InMemorySessionStore();
    const s = await session.createSession({
      key: 'k',
      platform: 'cli',
      model: 'm',
      provider: 'p',
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
    const res = await runManualCompaction(
      { session, summarizer },
      {
        sessionId: s.id,
        history: history(20),
        engineName: 'semantic_summary',
        instructions: 'the deploy bug',
        tailKeep: 6,
        summaryTargetTokens: 800,
      },
    );
    expect(res.ok).toBe(true);
    expect(seen.instructions).toBe('the deploy bug');
    expect(res.engineName).toBe('semantic_summary');
    // A watermark row was persisted with a boundary + summary.
    const wm = selectActiveWatermark(await session.listCompressions(s.id));
    expect(wm?.summaryText).toBe('summary');
    expect(wm?.keptFromMessageId).toBeTruthy();
  });

  it('degrades to drop_oldest with no hint-enabling summarizer', async () => {
    const session = new InMemorySessionStore();
    const s = await session.createSession({
      key: 'k',
      platform: 'cli',
      model: 'm',
      provider: 'p',
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
    const res = await runManualCompaction(
      { session },
      {
        sessionId: s.id,
        history: history(20),
        engineName: 'drop_oldest',
        tailKeep: 6,
        summaryTargetTokens: 800,
      },
    );
    expect(res.ok).toBe(true);
    expect(res.summariesEnabled).toBe(false);
    expect(res.engineName).toBe('drop_oldest');
    const wm = selectActiveWatermark(await session.listCompressions(s.id));
    expect(wm?.summaryText).toBeUndefined();
    expect(wm?.keptFromMessageId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: /compact persists a watermark, and the NEXT turn assembles from
// it (not raw history).
// ---------------------------------------------------------------------------

function capturingLLM(captured: Message[][]): LLMProvider {
  return {
    name: 'capture',
    model: 'mock',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      m: Message[],
      _t: unknown,
      _o: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      captured.push(m);
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _e of gen) void _e;
}

function makeLoop(session: InMemorySessionStore, captured: Message[][], summarizer?: SummarizerFn) {
  const personalities = new DefaultPersonalityRegistry();
  vi.spyOn(personalities, 'getDefault').mockReturnValue({ id: 'lean', name: 'Lean', toolset: [] });
  return new AgentLoop({
    llm: capturingLLM(captured),
    session,
    personalities,
    safety: createTestSafety(),
    // Production wires the manual-compact summarizer via the context-engine
    // LLM handle; mirror that here.
    ...(summarizer ? { llmHandle: { summarize: summarizer } } : {}),
  });
}

describe('/compact watermark end-to-end', () => {
  it('turn N+1 assembles from the persisted compaction, not raw history', async () => {
    const session = new InMemorySessionStore();
    const s = await session.createSession({
      key: 'cli:test',
      platform: 'cli',
      model: 'm',
      provider: 'p',
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
    for (let i = 0; i < 20; i++) {
      await session.appendMessage({
        sessionId: s.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `OLD-${i}`,
      });
    }

    const captured: Message[][] = [];
    const summarizer: SummarizerFn = async () => 'CONDENSED-SUMMARY';
    const loop = makeLoop(session, captured, summarizer);

    const result = await loop.compact('cli:test');
    expect(result.ok).toBe(true);
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.preTotalTokens).toBeGreaterThan(result.postTotalTokens);

    await drain(loop.run('a brand new question', { sessionKey: 'cli:test' }));

    expect(captured).toHaveLength(1);
    const sent = JSON.stringify(captured[0]);
    // The condensed summary is present; the oldest raw prefix is gone.
    expect(sent).toContain('CONDENSED-SUMMARY');
    expect(sent).not.toContain('OLD-0"');
    expect(sent).not.toContain('OLD-1"');
    // The freshest turn survived verbatim.
    expect(sent).toContain('a brand new question');
  });

  it('a cooldown turn (no new compaction) still ships the compacted view', async () => {
    const session = new InMemorySessionStore();
    const s = await session.createSession({
      key: 'cli:cool',
      platform: 'cli',
      model: 'm',
      provider: 'p',
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
    for (let i = 0; i < 16; i++) {
      await session.appendMessage({
        sessionId: s.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `RAW-${i}`,
      });
    }
    const captured: Message[][] = [];
    const loop = makeLoop(session, captured, async () => 'SUM');
    await loop.compact('cli:cool');

    // Two consecutive normal turns — both under the cooldown, both must replay
    // the persisted compaction rather than the raw prefix.
    await drain(loop.run('q1', { sessionKey: 'cli:cool' }));
    await drain(loop.run('q2', { sessionKey: 'cli:cool' }));

    for (const sent of captured.map((c) => JSON.stringify(c))) {
      expect(sent).toContain('SUM');
      expect(sent).not.toContain('RAW-0"');
    }
  });
});
