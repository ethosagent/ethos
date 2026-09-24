// openclaw-9.5-adoption item 7 — provider-side compaction, core half (D31–D33).
//
// Exactly one compactor per turn: when the provider a turn resolves to
// compacts server-side (`markServerCompaction`), the loop's own compactions —
// the pre-LLM gate, the overflow retry, the turn-end trigger — do not run. A
// `compaction` chunk is persisted as an envelope row ahead of the reply and
// replayed on the next request. A rejected edit (the provider's
// SERVER_COMPACTION_REJECTED_WARNING) hands compaction back to the loop for the
// rest of that turn.

import {
  type CompletionChunk,
  type ContextEngine,
  decodeCompactionEnvelope,
  type LLMProvider,
  type Message,
  SERVER_COMPACTION_REJECTED_WARNING,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { DefaultContextEngineRegistry } from '../context-engines/registry';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';
import {
  ChainedProvider,
  markServerCompaction,
  servesServerCompaction,
  tagProviderEntry,
} from '../providers/chained-provider';
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

/** LLM whose per-call chunks come from `respond`; every call's messages are logged. */
function makeLLM(
  respond: (index: number) => { chunks: CompletionChunk[]; throwOverflow?: boolean },
  log: Message[][] = [],
): LLMProvider {
  let index = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[]): AsyncIterable<CompletionChunk> {
      log.push(structuredClone(messages));
      const plan = respond(index++);
      for (const c of plan.chunks) yield c;
      if (plan.throwOverflow) throw new Error('400 invalid_request_error: prompt is too long');
    },
    async countTokens() {
      return 10;
    },
  };
}

function usageChunk(inputTokens: number): CompletionChunk {
  return {
    type: 'usage',
    usage: {
      inputTokens,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0,
    },
  };
}

const text = (t: string): CompletionChunk[] => [
  { type: 'text_delta', text: t },
  { type: 'done', finishReason: 'end_turn' },
];

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

async function seedSession(session: InMemorySessionStore, key: string, pairs: number) {
  const s = await session.createSession({
    key,
    platform: 'cli',
    model: 'mock-model',
    provider: 'mock',
    usage: { ...zeroUsage },
  });
  for (let i = 0; i < pairs; i++) {
    await session.appendMessage({ sessionId: s.id, role: 'user', content: `q${i}` });
    await session.appendMessage({ sessionId: s.id, role: 'assistant', content: `a${i}` });
  }
  return s;
}

/** A `drop_oldest` engine that records every call and keeps the last message. */
function spyEngines() {
  const compact = vi.fn<ContextEngine['compact']>(async (input) => ({
    messages: input.messages.slice(-1),
    notes: 'kept the last message',
  }));
  const registry = new DefaultContextEngineRegistry();
  registry.register({ name: 'drop_oldest', compact });
  return { registry, compact };
}

function observabilityLog(codes: string[]): AgentLoopObservability {
  return {
    startTurnTrace: () => 'tr1',
    endTrace: () => {},
    startSpan: () => 'sp1',
    endSpan: () => {},
    recordSafetyBlock: () => {},
    recordCompaction: (e) => codes.push(e.code ?? ''),
    recordTierEscalation: () => {},
    recordTierOverride: () => {},
    flush: () => {},
  };
}

const compactionNotices = (events: AgentEvent[]) =>
  events.filter((e) => e.type === 'tool_progress' && e.toolName === '_compaction');

describe('servesServerCompaction — which provider a turn resolves to', () => {
  const plain = () => makeLLM(() => ({ chunks: text('x') }));

  it('reads the mark on a single provider', () => {
    expect(servesServerCompaction(plain())).toBe(false);
    expect(servesServerCompaction(markServerCompaction(plain()))).toBe(true);
  });

  it('on a chain, reads the scoped entry, else the first entry not cooling down', () => {
    const anthropic = tagProviderEntry(markServerCompaction(plain()), 'claude');
    const other = tagProviderEntry(plain(), 'router');
    const chain = new ChainedProvider([anthropic, other]);
    expect(servesServerCompaction(chain)).toBe(true);
    expect(servesServerCompaction(chain, { key: 'router' })).toBe(false);
    expect(servesServerCompaction(chain, { key: 'claude' })).toBe(true);
    expect(servesServerCompaction(new ChainedProvider([other, anthropic]))).toBe(false);
  });
});

describe('ChainedProvider forwards the compaction variant', () => {
  it('passes a compaction chunk through untouched', async () => {
    const chunk: CompletionChunk = { type: 'compaction', content: 's', encryptedContent: 'e' };
    const chain = new ChainedProvider([makeLLM(() => ({ chunks: [chunk, ...text('ok')] }))]);
    const out: CompletionChunk[] = [];
    for await (const c of chain.complete([], [], {})) out.push(c);
    expect(out[0]).toEqual(chunk);
  });
});

describe('exactly one compactor per turn (D32)', () => {
  it('pre-LLM gate: compacts locally on an unmarked provider, skips on a marked one', async () => {
    for (const marked of [false, true]) {
      const { registry, compact } = spyEngines();
      const session = new InMemorySessionStore();
      await seedSession(session, 'cli:pre', 4);
      const base = makeLLM(() => ({ chunks: text('ok') }));
      const loop = new AgentLoop({
        llm: marked ? markServerCompaction(base) : base,
        session,
        safety: createTestSafety(),
        contextEngines: registry,
        // A 1-token ceiling puts every history over the gate.
        compaction: { maxContextTokens: 1, autoCompact: false },
      });
      await collect(loop.run('next', { sessionKey: 'cli:pre' }));
      if (marked) expect(compact).not.toHaveBeenCalled();
      else expect(compact).toHaveBeenCalled();
    }
  });

  it('overflow retry: no local emergency compaction while the provider compacts', async () => {
    for (const marked of [false, true]) {
      const { registry, compact } = spyEngines();
      const base = makeLLM((i) =>
        i === 0 ? { chunks: [], throwOverflow: true } : { chunks: text('ok') },
      );
      const loop = new AgentLoop({
        llm: marked ? markServerCompaction(base) : base,
        session: new InMemorySessionStore(),
        safety: createTestSafety(),
        contextEngines: registry,
        compaction: { autoCompact: false },
      });
      const events = await collect(loop.run('go', { sessionKey: 'cli:overflow' }));
      const error = events.find((e) => e.type === 'error');
      if (marked) {
        expect(compact).not.toHaveBeenCalled();
        expect(error?.type === 'error' && error.code).toBe('context_overflow');
      } else {
        expect(compact).toHaveBeenCalled();
      }
    }
  });

  it('turn-end trigger: compacts locally on an unmarked provider, skips on a marked one', async () => {
    for (const marked of [false, true]) {
      const session = new InMemorySessionStore();
      await seedSession(session, 'cli:end', 8);
      // This turn's ACTUAL input is past 80% of 200k → the turn-end gate trips.
      const base = makeLLM(() => ({ chunks: [...text('ok'), usageChunk(170_000)] }));
      const loop = new AgentLoop({
        llm: marked ? markServerCompaction(base) : base,
        session,
        safety: createTestSafety(),
        compaction: { autoCompact: true },
      });
      const events = await collect(loop.run('next', { sessionKey: 'cli:end' }));
      expect(compactionNotices(events)).toHaveLength(marked ? 0 : 1);
    }
  });

  it('a rejected edit hands compaction back to the loop for the rest of the turn', async () => {
    const session = new InMemorySessionStore();
    await seedSession(session, 'cli:rejected', 8);
    const codes: string[] = [];
    const llm = markServerCompaction(
      makeLLM(() => ({
        chunks: [
          { type: 'warning', message: SERVER_COMPACTION_REJECTED_WARNING },
          ...text('ok'),
          usageChunk(170_000),
        ],
      })),
    );
    const loop = new AgentLoop({
      llm,
      session,
      safety: createTestSafety(),
      observability: observabilityLog(codes),
      compaction: { autoCompact: true },
    });
    const events = await collect(loop.run('next', { sessionKey: 'cli:rejected' }));
    expect(codes).toContain('llm.server_compaction_rejected');
    // The turn-end trigger ran locally, as it would with no server compaction.
    expect(compactionNotices(events)).toHaveLength(1);
  });
});

describe('compaction chunk persistence (D31)', () => {
  it('persists the block as an envelope row ahead of the reply and replays it next turn', async () => {
    const session = new InMemorySessionStore();
    const log: Message[][] = [];
    const encrypted = 'opaque+/=bytesé\n"quoted"';
    const llm = markServerCompaction(
      makeLLM(
        (i) => ({
          chunks:
            i === 0
              ? [
                  { type: 'compaction', content: 'the summary', encryptedContent: encrypted },
                  ...text('first reply'),
                ]
              : text('second reply'),
        }),
        log,
      ),
    );
    const loop = new AgentLoop({ llm, session, safety: createTestSafety() });
    await collect(loop.run('one', { sessionKey: 'cli:persist' }));

    const s = await session.getSessionByKey('cli:persist');
    const rows = await session.getMessages(s?.id ?? '');
    const roles = rows.map((r) => r.role);
    expect(roles).toEqual(['user', 'assistant', 'assistant']);
    expect(decodeCompactionEnvelope(rows[1]?.content ?? '')).toEqual({
      content: 'the summary',
      encryptedContent: encrypted,
    });
    expect(rows[2]?.content).toBe('first reply');

    await collect(loop.run('two', { sessionKey: 'cli:persist' }));
    const replayed = log[1] ?? [];
    const envelope = replayed.find(
      (m) => typeof m.content === 'string' && decodeCompactionEnvelope(m.content) !== null,
    );
    expect(decodeCompactionEnvelope(envelope?.content as string)?.encryptedContent).toBe(encrypted);
    // Envelope, then the reply it came with, in that order.
    const at = replayed.indexOf(envelope as Message);
    expect(replayed[at + 1]).toEqual({ role: 'assistant', content: 'first reply' });
  });
});
