import { HistoryStore } from '@ethosagent/memory-history';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  AgentDonePayload,
  HookRegistry,
  LLMProvider,
  Logger,
  MemoryContext,
  Session,
  SessionStore,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { hashFact } from '../dedup';
import { MemoryCaptureRunner, type MemoryCaptureRunnerOptions } from '../runner';
import type { CaptureJob } from '../types';

const DATA = '/root/.ethos';
const LONG =
  'My daughter Priya was born in 2019 and I work as a staff engineer at Acme Corp, and I love tea.';
const FACT = 'USER|0.8|Has a daughter named Priya, born 2019.';

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};

function makeLlm(response: string | (() => string)) {
  const calls: string[] = [];
  const llm: LLMProvider = {
    name: 'fake',
    model: 'fake-model',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete() {
      const text = typeof response === 'function' ? response() : response;
      calls.push(text);
      yield { type: 'text_delta', text };
    },
    async countTokens() {
      return 0;
    },
  };
  return { llm, calls };
}

function makeSession(map: Record<string, string>): SessionStore {
  return {
    getSession: async (id: string) =>
      id in map ? ({ id, key: map[id] } as unknown as Session) : null,
  } as unknown as SessionStore;
}

function ctx(scopeId = 'personality:muse'): MemoryContext {
  return { scopeId, sessionId: 's1', sessionKey: 'cli:ethos', platform: 'cli', workingDir: DATA };
}

interface Harness {
  runner: MemoryCaptureRunner;
  storage: InMemoryStorage;
  history: HistoryStore;
  provider: MarkdownFileMemoryProvider;
  llmCalls: string[];
}

function makeHarness(
  over: Partial<MemoryCaptureRunnerOptions> = {},
  llmResponse: string | (() => string) = FACT,
  shared?: {
    storage: InMemoryStorage;
    history: HistoryStore;
    provider: MarkdownFileMemoryProvider;
  },
): Harness {
  const storage = shared?.storage ?? new InMemoryStorage();
  const provider = shared?.provider ?? new MarkdownFileMemoryProvider({ dir: DATA, storage });
  const history = shared?.history ?? new HistoryStore({ dataDir: DATA, storage });
  const { llm, calls } = makeLlm(llmResponse);
  const runner = new MemoryCaptureRunner({
    provider,
    history,
    session: makeSession({ s1: 'cli:ethos' }),
    llm,
    sanitize: (s) => s,
    logger: NOOP_LOGGER,
    nightlyConfigured: false,
    workingDir: DATA,
    ...over,
  });
  return { runner, storage, history, provider, llmCalls: calls };
}

const JOB: CaptureJob = {
  sessionId: 's1',
  personalityId: 'muse',
  text: 'Congrats!',
  initialPrompt: LONG,
  isDryRun: false,
};

async function capture(runner: MemoryCaptureRunner, job: CaptureJob = JOB): Promise<void> {
  runner.enqueue(job);
  await runner.whenIdle();
}

describe('MemoryCaptureRunner', () => {
  it('records a capture with source:capture and the extraction hint', async () => {
    const h = makeHarness();
    await capture(h.runner);
    const { entries } = await h.history.read('personality:muse');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe('capture');
    expect(entries[0]?.key).toBe('USER.md');
    expect(entries[0]?.hint).toBe(0.8);
    expect(entries[0]?.captureHashes).toContain(hashFact('Has a daughter named Priya, born 2019.'));
  });

  it('runs content-safety sanitize on the extracted fact', async () => {
    const sanitize = vi.fn((s: string) => s.replace('Priya', 'REDACTED'));
    const h = makeHarness({ sanitize });
    await capture(h.runner);
    expect(sanitize).toHaveBeenCalled();
    const after = (await h.provider.read('USER.md', ctx()))?.content ?? '';
    expect(after).toContain('REDACTED');
  });

  it('fires onCaptured after the write lands', async () => {
    const h = makeHarness();
    const notices: string[] = [];
    h.runner.onCaptured((n) => notices.push(n.summary));
    await capture(h.runner);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Priya');
  });

  it('enqueues fast and defers extraction until after the queue drains', async () => {
    const h = makeHarness();
    let handler: ((p: AgentDonePayload) => Promise<void>) | undefined;
    const hooks = {
      registerVoid: (_name: string, fn: (p: AgentDonePayload) => Promise<void>) => {
        handler = fn;
        return () => {};
      },
    } as unknown as HookRegistry;
    h.runner.registerHook(hooks);
    expect(handler).toBeDefined();

    const payload: AgentDonePayload = {
      sessionId: 's1',
      text: 'Congrats!',
      turnCount: 1,
      personalityId: 'muse',
      initialPrompt: LONG,
    };
    const t0 = performance.now();
    // Do NOT await — the synchronous portion must not touch the LLM.
    const pending = handler?.(payload);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(5);
    expect(h.llmCalls).toHaveLength(0);

    await pending;
    await h.runner.whenIdle();
    expect(h.llmCalls).toHaveLength(1);
  });

  it('never writes outside the turn personality scope', async () => {
    const h = makeHarness();
    await capture(h.runner);
    expect((await h.history.read('personality:muse')).entries).toHaveLength(1);
    expect((await h.history.read('personality:other')).entries).toHaveLength(0);
  });

  it('skips ineligible turns without an LLM call (dream session)', async () => {
    const h = makeHarness({ session: makeSession({ s1: 'dream:ethos' }) });
    await capture(h.runner);
    expect(h.llmCalls).toHaveLength(0);
    expect((await h.history.read('personality:muse')).entries).toHaveLength(0);
  });

  it('skips child (:sub:) sessions', async () => {
    const h = makeHarness({ session: makeSession({ s1: 'cli:ethos:sub:task:2' }) });
    await capture(h.runner);
    expect(h.llmCalls).toHaveLength(0);
  });

  it('skips synthetic background-job wake turns', async () => {
    const h = makeHarness();
    await capture(h.runner, {
      ...JOB,
      initialPrompt: '[background job ab12cd34 finished — status: done]\n\nchild output',
    });
    expect(h.llmCalls).toHaveLength(0);
  });

  it('enforces the per-hour rate cap from history', async () => {
    const h = makeHarness({ config: { maxPerHour: 2 } });
    // Two distinct facts, two captures → at cap.
    const responses = ['USER|0.5|Fact one about the user.', 'USER|0.5|Fact two about the user.'];
    let i = 0;
    const h2 = makeHarness({ config: { maxPerHour: 2 } }, () => responses[i++] ?? 'NONE', {
      storage: h.storage,
      history: h.history,
      provider: h.provider,
    });
    await capture(h2.runner);
    await capture(h2.runner);
    expect((await h.history.read('personality:muse')).entries).toHaveLength(2);
    // Third capture is blocked before any extraction.
    const h3 = makeHarness({ config: { maxPerHour: 2 } }, 'USER|0.5|Third fact entirely.', {
      storage: h.storage,
      history: h.history,
      provider: h.provider,
    });
    await capture(h3.runner);
    expect(h3.llmCalls).toHaveLength(0);
    expect((await h.history.read('personality:muse')).entries).toHaveLength(2);
  });

  it('dedups the same fact → one write, even after the file is reworded', async () => {
    const h = makeHarness();
    await capture(h.runner);
    expect((await h.history.read('personality:muse')).entries).toHaveLength(1);

    // Simulate a nightly reword that rewrites USER.md in different words.
    await h.provider.sync(
      [{ action: 'replace', key: 'USER.md', content: 'The user is a parent to a young child.' }],
      ctx(),
    );

    // User restates the same fact; extraction yields it again.
    const h2 = makeHarness(undefined, FACT, {
      storage: h.storage,
      history: h.history,
      provider: h.provider,
    });
    await capture(h2.runner);
    expect(h2.llmCalls).toHaveLength(1); // extraction ran…
    const captures = (await h.history.read('personality:muse', { source: 'capture' })).entries;
    expect(captures).toHaveLength(1); // …but no second capture write.
  });

  it('dedups across two processes sharing the same history → one write', async () => {
    const storage = new InMemoryStorage();
    const provider = new MarkdownFileMemoryProvider({ dir: DATA, storage });
    const history = new HistoryStore({ dataDir: DATA, storage });
    const procA = makeHarness(undefined, FACT, { storage, history, provider });
    const procB = makeHarness(undefined, FACT, { storage, history, provider });
    await capture(procA.runner);
    await capture(procB.runner);
    const captures = (await history.read('personality:muse', { source: 'capture' })).entries;
    expect(captures).toHaveLength(1);
  });

  const MEMORY_FACT = 'MEMORY|0.6|Working on the Q3 launch, deadline mid-September.';

  it('triggers inline consolidation exactly once on a no-nightly install', async () => {
    const consolidate = vi.fn(async () => {});
    const h = makeHarness(
      {
        nightlyConfigured: false,
        consolidate,
        config: { consolidationSizeThreshold: 1 }, // any MEMORY.md write crosses it
      },
      MEMORY_FACT,
    );
    await capture(h.runner);
    expect(consolidate).toHaveBeenCalledTimes(1);
  });

  it('never inline-consolidates when a nightly loop is configured', async () => {
    const consolidate = vi.fn(async () => {});
    const h = makeHarness(
      {
        nightlyConfigured: true,
        consolidate,
        config: { consolidationSizeThreshold: 1 },
      },
      MEMORY_FACT,
    );
    await capture(h.runner);
    expect(consolidate).not.toHaveBeenCalled();
  });

  it('writes nothing for chit-chat (NONE extraction)', async () => {
    const h = makeHarness(undefined, 'NONE');
    await capture(h.runner);
    expect((await h.history.read('personality:muse')).entries).toHaveLength(0);
  });
});
