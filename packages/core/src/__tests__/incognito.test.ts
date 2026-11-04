// plan incognito-sessions Part A — an incognito turn is a `'shared'` turn for
// memory (D1) plus: the process tools come back for the owner (D3), the stamp
// is sticky (D6), a shared caller never gains the shell or the stamp (D5), no
// compaction page leaves the session store (D9) and the turn's observability
// config stores neither tool args nor LLM payloads (D10).
//
// Enforcers: `incognito` in `setupTurn` (stages/turn-setup.ts),
// `isIncognitoSession` / `incognitoSessionMetadata` / `sessionAudienceStampFor`
// (chat-audience.ts), `withSharedAudienceExclusions(…, readmit)` and
// `INCOGNITO_READMITTED_TOOLS` (agent-loop/audience.ts), `buildStore`
// (agent-loop/turn-complete.ts) and `maybeCompact` (agent-loop/compaction.ts).
// Every assertion is on the thing that would leak: provider CALLS, the tool
// DEFINITIONS the LLM receives, tool EXECUTIONS, persisted session METADATA,
// files under `compaction/`.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  CompletionChunk,
  ContextEngine,
  ContextEngineCompactInput,
  ContextEngineCompactOutput,
  ContextEngineStore,
  LLMProvider,
  MemoryEntry,
  MemoryProvider,
  MemorySnapshot,
  Message,
  PersonalityConfig,
  Tool,
  ToolDefinitionLite,
  UsageAttribution,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { INCOGNITO_READMITTED_TOOLS } from '../agent-loop/audience';
import { isIncognitoSession } from '../chat-audience';
import { DefaultContextEngineRegistry } from '../context-engines/registry';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';
import { DefaultToolRegistry } from '../tool-registry';
import { activeUsageScope } from '../usage-scope';
import { createTestSafety } from './helpers/test-safety';

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

interface Call {
  tools: string[];
}

/** Records each call's tool names; when `attempt` is set the first call asks for that tool. */
function recordingLLM(calls: Call[], attempt?: string): LLMProvider {
  let n = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(_m: Message[], tools: ToolDefinitionLite[]): AsyncIterable<CompletionChunk> {
      calls.push({ tools: tools.map((t) => t.name) });
      if (attempt && n++ === 0) {
        yield { type: 'tool_use_start', toolCallId: 'c1', toolName: attempt };
        yield { type: 'tool_use_end', toolCallId: 'c1', inputJson: '{}' };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function spyMemory(): MemoryProvider & {
  calls: { prefetch: number; read: number; search: number; sync: number };
} {
  const calls = { prefetch: 0, read: 0, search: 0, sync: 0 };
  return {
    calls,
    async prefetch(): Promise<MemorySnapshot | null> {
      calls.prefetch++;
      return { entries: [{ key: 'MEMORY.md', content: 'canary: interview at ACME' }] };
    },
    async read(key: string): Promise<MemoryEntry | null> {
      calls.read++;
      return { key, content: 'The user prefers terse answers.' };
    },
    async search() {
      calls.search++;
      return [{ key: 'NOTE.md', content: 'hit' }];
    },
    async sync() {
      calls.sync++;
    },
    async list() {
      return [];
    },
  };
}

function personalities(toolset: string[], extra: Partial<PersonalityConfig> = {}) {
  const reg = new DefaultPersonalityRegistry();
  vi.spyOn(reg, 'getDefault').mockReturnValue({ id: 'lean', name: 'Lean', toolset, ...extra });
  return reg;
}

const WATCHED = [
  'memory_read',
  'memory_write',
  'session_list_by_date',
  'dashboard_add_panel',
  'terminal',
  'run_code',
  'process_start',
  'session_search',
];

function registry(runs: string[]): DefaultToolRegistry {
  const tools = new DefaultToolRegistry();
  for (const name of WATCHED) {
    const t: Tool = {
      name,
      description: name,
      toolset: 'test',
      capabilities: {},
      schema: { type: 'object', properties: {} },
      async execute() {
        runs.push(name);
        return { ok: true, value: 'ok' };
      },
    };
    tools.register(t);
  }
  return tools;
}

function build(opts: { attempt?: string; observability?: AgentLoopObservability } = {}) {
  const memory = spyMemory();
  const calls: Call[] = [];
  const runs: string[] = [];
  const session = new InMemorySessionStore();
  const loop = new AgentLoop({
    llm: recordingLLM(calls, opts.attempt),
    personalities: personalities(WATCHED),
    tools: registry(runs),
    session,
    safety: createTestSafety(),
    memory,
    memoryConsolidation: { enabled: true, flushThreshold: 0.0001, minMessagesSinceFlush: 1 },
    ...(opts.observability ? { observability: opts.observability } : {}),
  });
  return { loop, memory, calls, runs, session };
}

const METADATA_INCOGNITO = { roomAudience: 'shared', incognito: true };

describe('an incognito turn is a shared turn for memory', () => {
  it('reads no memory, even with userId set', async () => {
    const { loop, memory } = build();
    await drain(loop.run('hello', { userId: 'u1', sessionKey: 'cli:i1', incognito: true }));
    expect(memory.calls).toEqual({ prefetch: 0, read: 0, search: 0, sync: 0 });
  });

  it('writes no memory: no flush sync, and memory_write is refused', async () => {
    const { loop, memory, runs } = build({ attempt: 'memory_write' });
    await drain(loop.run('remember this', { userId: 'u1', sessionKey: 'cli:i2', incognito: true }));
    expect(memory.calls.sync).toBe(0);
    expect(runs).not.toContain('memory_write');
  });

  it('tool definitions: no memory tools, the process tools are present', async () => {
    const { loop, calls } = build();
    await drain(loop.run('hello', { sessionKey: 'cli:i3', incognito: true }));
    const names = calls[0]?.tools ?? [];
    for (const gone of [
      'memory_read',
      'memory_write',
      'session_list_by_date',
      'dashboard_add_panel',
    ]) {
      expect(names).not.toContain(gone);
    }
    for (const kept of ['terminal', 'run_code', 'process_start', 'session_search']) {
      expect(names).toContain(kept);
    }
  });

  it('the re-admitted shell actually executes', async () => {
    const { loop, runs } = build({ attempt: 'terminal' });
    await drain(loop.run('ls', { sessionKey: 'cli:i3b', incognito: true }));
    expect(runs).toContain('terminal');
  });

  it('a private control turn has every tool and reads memory', async () => {
    const { loop, memory, calls } = build();
    await drain(loop.run('hello', { userId: 'u1', sessionKey: 'cli:ctl' }));
    expect(memory.calls.prefetch).toBe(1);
    expect(calls[0]?.tools).toEqual(expect.arrayContaining(WATCHED));
  });
});

describe('the stamp is written once and is sticky (D4, D6)', () => {
  it('turn 1 stamps both keys; later turns stay incognito whatever the caller passes', async () => {
    const { loop, memory, calls, session } = build();
    const key = 'cli:sticky';
    await drain(loop.run('one', { userId: 'u1', sessionKey: key, incognito: true }));
    expect((await session.getSessionByKey(key))?.metadata).toEqual(METADATA_INCOGNITO);

    await drain(loop.run('two', { userId: 'u1', sessionKey: key }));
    await drain(loop.run('three', { userId: 'u1', sessionKey: key, roomAudience: 'private' }));
    await drain(loop.run('four', { userId: 'u1', sessionKey: key, incognito: false }));

    const stored = await session.getSessionByKey(key);
    expect(stored && isIncognitoSession(stored)).toBe(true);
    expect(stored?.metadata).toEqual(METADATA_INCOGNITO);
    expect(memory.calls).toEqual({ prefetch: 0, read: 0, search: 0, sync: 0 });
    for (const call of calls) expect(call.tools).not.toContain('memory_read');
    for (const call of calls) expect(call.tools).toContain('terminal');
  });

  it('a stamped-incognito row with no roomAudience stamp still runs shared (fail closed)', async () => {
    const { loop, memory, calls, session } = build();
    const key = 'cli:half-stamp';
    await session.createSession({
      key,
      platform: 'cli',
      model: 'm',
      provider: 'p',
      metadata: { incognito: true },
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
    await drain(loop.run('hello', { userId: 'u1', sessionKey: key }));
    expect(memory.calls.prefetch).toBe(0);
    expect(calls[0]?.tools).not.toContain('memory_read');
    expect((await session.getSessionByKey(key))?.metadata).toEqual(METADATA_INCOGNITO);
  });
});

describe('a shared caller never gets the shell or the stamp (D3, D5)', () => {
  it.each([
    ['roomAudience: shared', { roomAudience: 'shared' as const }],
    ['skipPersonalityMemory', { skipPersonalityMemory: true }],
  ])('incognito: true + %s', async (_label, extra) => {
    const { loop, calls, session } = build();
    const key = `cli:shared-${_label}`;
    await drain(loop.run('hello', { sessionKey: key, incognito: true, ...extra }));
    const names = calls[0]?.tools ?? [];
    for (const name of INCOGNITO_READMITTED_TOOLS) expect(names).not.toContain(name);
    const meta = (await session.getSessionByKey(key))?.metadata;
    expect(meta?.incognito).toBeUndefined();
  });

  it('an incognito-stamped session reached by a shared caller runs plain shared', async () => {
    const { loop, calls } = build();
    const key = 'cli:stamped-then-shared';
    await drain(loop.run('one', { sessionKey: key, incognito: true }));
    expect(calls[0]?.tools).toContain('terminal');
    await drain(loop.run('two', { sessionKey: key, roomAudience: 'shared' }));
    expect(calls[1]?.tools).not.toContain('terminal');
    expect(calls[1]?.tools).not.toContain('memory_read');
  });
});

describe('descendants inherit the stamp, never the shell (D1, fail closed)', () => {
  it.each([':sub:abc', ':job:xyz', ':sub:a:sub:b'])(
    'a shared child %s of an incognito session is stamped incognito and has no shell',
    async (suffix) => {
      const { loop, calls, session } = build();
      const parent = 'cli:parent';
      await drain(loop.run('one', { sessionKey: parent, incognito: true }));
      const childKey = `${parent}${suffix}`;
      await drain(loop.run('task', { sessionKey: childKey, roomAudience: 'shared' }));
      const child = await session.getSessionByKey(childKey);
      expect(child && isIncognitoSession(child)).toBe(true);
      expect(child?.metadata).toEqual(METADATA_INCOGNITO);
      expect(calls[1]?.tools).not.toContain('terminal');
      expect(calls[1]?.tools).not.toContain('memory_read');
    },
  );

  it('a child of a normal session is not stamped', async () => {
    const { loop, session } = build();
    await drain(loop.run('one', { sessionKey: 'cli:plain' }));
    await drain(loop.run('task', { sessionKey: 'cli:plain:sub:a', roomAudience: 'shared' }));
    expect((await session.getSessionByKey('cli:plain:sub:a'))?.metadata?.incognito).toBeUndefined();
  });

  it('fails closed: a throwing ancestor lookup stamps the child', async () => {
    const { loop, session } = build();
    const real = session.getSessionByKey.bind(session);
    session.getSessionByKey = async (k: string) => {
      if (k === 'cli:boom') throw new Error('db down');
      return real(k);
    };
    await drain(loop.run('task', { sessionKey: 'cli:boom:sub:a', roomAudience: 'shared' }));
    expect((await real('cli:boom:sub:a'))?.metadata?.incognito).toBe(true);
  });
});

describe('an already-shared, non-incognito transcript is never made incognito (public API)', () => {
  it.each([
    ['roomAudience stamp', { roomAudience: 'shared' } as Record<string, unknown>],
    [
      'personalityMemoryWithheld marker',
      { personalityMemoryWithheld: true } as Record<string, unknown>,
    ],
  ])('%s', async (_label, metadata) => {
    const { loop, calls, session } = build();
    const key = `cli:group-${_label}`;
    await session.createSession({
      key,
      platform: 'cli',
      model: 'm',
      provider: 'p',
      metadata,
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
    await drain(loop.run('hello', { sessionKey: key, incognito: true }));
    expect((await session.getSessionByKey(key))?.metadata?.incognito).toBeUndefined();
    // Shared stamp: no re-admission. (A withheld-only session keeps its normal
    // private toolset, so only the stamp is pinned there.)
    if (metadata.roomAudience === 'shared') {
      for (const name of INCOGNITO_READMITTED_TOOLS) expect(calls[0]?.tools).not.toContain(name);
    }
  });
});

describe('no compaction page outside sessions.db (D9)', () => {
  /** An engine that pages to its store when it has one, and records whether it did. */
  function pagingEngine() {
    const seen = { compactStore: [] as boolean[], completeStore: [] as boolean[] };
    const engine: ContextEngine = {
      name: 'paging',
      async compact(opts: ContextEngineCompactInput): Promise<ContextEngineCompactOutput> {
        const store: ContextEngineStore | undefined = opts.store;
        seen.compactStore.push(store !== undefined);
        await store?.write('paged-1', 'raw middle of the conversation');
        return { messages: opts.messages.slice(-1), notes: 'paged' };
      },
      async onTurnComplete(input) {
        seen.completeStore.push(input.store !== undefined);
        await input.store?.write('state', 'x');
        return null;
      },
    };
    return { engine, seen };
  }

  async function run(incognito: boolean) {
    const { engine, seen } = pagingEngine();
    const contextEngines = new DefaultContextEngineRegistry();
    contextEngines.register(engine);
    const storage = new InMemoryStorage();
    await storage.mkdir('/data/compaction/lean');
    // Long turns against a small window, so turn 2 hits the pre-LLM gate.
    const llm: LLMProvider = { ...recordingLLM([]), maxContextTokens: 20_000 };
    const loop = new AgentLoop({
      llm,
      personalities: personalities([], { context_engine: 'paging' }),
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
      contextEngines,
      storage,
      dataDir: '/data',
    });
    for (const text of ['a', 'b', 'c'].map((c) => c.repeat(20_000))) {
      const evs = await drain(
        loop.run(text, { sessionKey: 'cli:page', ...(incognito ? { incognito } : {}) }),
      );
      expect(evs.some((e) => e.type === 'error')).toBe(false);
    }
    return { seen, listed: await storage.list('/data/compaction/lean') };
  }

  it('control: a normal turn gives the engine a store and a page is written', async () => {
    const { seen, listed } = await run(false);
    expect(seen.completeStore.every(Boolean)).toBe(true);
    expect(seen.compactStore.length).toBeGreaterThan(0);
    expect(seen.compactStore.every(Boolean)).toBe(true);
    expect(listed.length).toBeGreaterThan(0);
  });

  it('an incognito turn gives the engine no store (compact and onTurnComplete) and writes nothing', async () => {
    const { seen, listed } = await run(true);
    expect(seen.completeStore.length).toBeGreaterThan(0);
    expect(seen.completeStore.some(Boolean)).toBe(false);
    expect(seen.compactStore.length).toBeGreaterThan(0);
    expect(seen.compactStore.some(Boolean)).toBe(false);
    expect(listed).toEqual([]);
  });
});

describe('observability keeps metadata, not content (D10)', () => {
  function spyObservability() {
    const traces: unknown[] = [];
    const spans: Array<{ kind: string; obsConfig: unknown }> = [];
    const observability: AgentLoopObservability = {
      startTurnTrace: (opts) => {
        traces.push(opts.obsConfig);
        return 'trace-1';
      },
      endTrace: () => {},
      startSpan: (opts) => {
        spans.push({ kind: opts.kind, obsConfig: opts.obsConfig });
        return 'span-1';
      },
      endSpan: () => {},
      recordSafetyBlock: () => {},
      recordCompaction: () => {},
      recordTierEscalation: () => {},
      recordTierOverride: () => {},
      flush: () => {},
    };
    return { observability, traces, spans };
  }

  it('the trace and the tool_call span carry storeToolArgs none and no full LLM payloads', async () => {
    const spy = spyObservability();
    const { loop } = build({ attempt: 'session_search', observability: spy.observability });
    await drain(loop.run('hi', { sessionKey: 'cli:obs', incognito: true }));
    const toolSpans = spy.spans.filter((s) => s.kind === 'tool_call');
    expect(toolSpans.length).toBeGreaterThan(0);
    for (const cfg of [...spy.traces, ...toolSpans.map((s) => s.obsConfig)]) {
      expect(cfg).toMatchObject({ storeToolArgs: 'none' });
      expect((cfg as { storeLlmPayloads?: string }).storeLlmPayloads).not.toBe('full');
    }
  });

  it('a normal turn keeps the personality config untouched', async () => {
    const spy = spyObservability();
    const { loop } = build({ observability: spy.observability });
    await drain(loop.run('hi', { sessionKey: 'cli:obs-ctl' }));
    expect(spy.traces).toEqual([undefined]);
  });
});

describe('D16 — manual /compact usage attribution', () => {
  async function compactScopeKey(metadata?: Record<string, unknown>) {
    const session = new InMemorySessionStore();
    const created = await session.createSession({
      key: 'cli:cmp',
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
      ...(metadata ? { metadata } : {}),
    });
    for (let i = 0; i < 20; i++) {
      await session.appendMessage({
        sessionId: created.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `M-${i}`,
      });
    }
    let seen: UsageAttribution | undefined;
    const loop = new AgentLoop({
      llm: recordingLLM([]),
      personalities: personalities(WATCHED),
      tools: registry([]),
      session,
      safety: createTestSafety(),
      usage: { recorder: { record: () => {} } },
      llmHandle: {
        summarize: async () => {
          seen = activeUsageScope()?.attribution;
          return 'SUM';
        },
      },
    });
    await loop.compact('cli:cmp');
    return seen;
  }

  it('manual compact on an incognito session opens the scope without sessionKey', async () => {
    const seen = await compactScopeKey(METADATA_INCOGNITO);
    expect(seen).toEqual({ platform: 'cli' });
  });

  it('manual compact on a normal session keeps sessionKey', async () => {
    const seen = await compactScopeKey();
    expect(seen).toEqual({ sessionKey: 'cli:cmp', platform: 'cli' });
  });
});
