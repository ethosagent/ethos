// memory-lifecycle L2 — capture honours the approval gate: it PROPOSES instead
// of writing, and never re-proposes a rejected (tombstoned) fact.
import { PendingMemoryStore, TombstoneStore } from '@ethosagent/memory-approval';
import { HistoryStore } from '@ethosagent/memory-history';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Logger, MemoryContext, Session, SessionStore } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { hashFact } from '../dedup';
import { MemoryCaptureRunner } from '../runner';
import type { CaptureJob } from '../types';

const DATA = '/root/.ethos';
const SCOPE = 'personality:muse';
const LONG =
  'My daughter Priya was born in 2019 and I work as a staff engineer at Acme Corp, and I love tea.';
const FACT = 'USER|0.8|Has a daughter named Priya, born 2019.';
const FACT_HASH = hashFact('Has a daughter named Priya, born 2019.');

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};

function makeLlm() {
  return {
    name: 'fake',
    model: 'fake-model',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete() {
      yield { type: 'text_delta' as const, text: FACT };
    },
    async countTokens() {
      return 0;
    },
  };
}

function makeSession(): SessionStore {
  return {
    getSession: async (id: string) => ({ id, key: 'cli:ethos' }) as unknown as Session,
  } as unknown as SessionStore;
}

function ctx(): MemoryContext {
  return {
    scopeId: SCOPE,
    sessionId: 's1',
    sessionKey: 'cli:ethos',
    platform: 'cli',
    workingDir: DATA,
  };
}

const JOB: CaptureJob = {
  sessionId: 's1',
  personalityId: 'muse',
  text: 'Congrats!',
  initialPrompt: LONG,
  isDryRun: false,
};

async function drain(runner: MemoryCaptureRunner): Promise<void> {
  runner.enqueue(JOB);
  await runner.whenIdle();
}

describe('MemoryCaptureRunner — approval gate', () => {
  function harness() {
    const storage = new InMemoryStorage();
    const provider = new MarkdownFileMemoryProvider({ dir: DATA, storage });
    const history = new HistoryStore({ dataDir: DATA, storage });
    const tombstones = new TombstoneStore({ storage, dataDir: DATA });
    const pending = new PendingMemoryStore({
      storage,
      dataDir: DATA,
      tombstones,
      apply: async () => {},
    });
    const runner = new MemoryCaptureRunner({
      provider,
      history,
      session: makeSession(),
      llm: makeLlm(),
      sanitize: (s) => s,
      logger: NOOP_LOGGER,
      nightlyConfigured: false,
      workingDir: DATA,
      tombstones,
      propose: async (p) => {
        await pending.propose(p);
      },
    });
    return { runner, provider, history, pending, tombstones };
  }

  it('proposes (does not write durably) when gated', async () => {
    const h = harness();
    await drain(h.runner);

    // Nothing durable, no history entry — the fact is only parked.
    expect((await h.provider.read('USER.md', ctx()))?.content ?? '').not.toContain('Priya');
    expect((await h.history.read(SCOPE)).entries).toHaveLength(0);

    const parked = await h.pending.list(SCOPE);
    expect(parked).toHaveLength(1);
    expect(parked[0]?.source).toBe('capture');
    expect(parked[0]?.factHash).toBe(FACT_HASH);
  });

  it('never re-proposes a rejected fact', async () => {
    const h = harness();
    await drain(h.runner);

    const parked = await h.pending.list(SCOPE);
    expect(parked).toHaveLength(1);
    const id = parked[0]?.id ?? '';

    // Reject → tombstones the fact-hash.
    await h.pending.reject(SCOPE, id, 'bad inference');
    expect(await h.tombstones.has(SCOPE, FACT_HASH)).toBe(true);
    expect(await h.pending.list(SCOPE)).toHaveLength(0);

    // The very same fact is restated in a later turn — capture must skip it.
    await drain(h.runner);
    expect(await h.pending.list(SCOPE)).toHaveLength(0);
  });
});
