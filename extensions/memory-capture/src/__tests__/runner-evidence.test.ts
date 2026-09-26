// Evidence-gated promotion (plan openclaw-9.5-adoption item 3, D22), end to end
// through the real runner: approval `off` + `memoryCapture.evidenceSessions: 3`
// means capture proposes to a capture-only queue, the fact waits until three
// distinct sessions have extracted it, and is then written through the
// history-recording approve path as `approvedBy: 'evidence'`. The runner itself
// is unchanged — this pins how it composes with the store as wiring builds it.
import { PendingMemoryStore, TombstoneStore } from '@ethosagent/memory-approval';
import { HistoryStore, withHistory } from '@ethosagent/memory-history';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Logger, MemoryContext, Session, SessionStore } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { hashFact } from '../dedup';
import { MemoryCaptureRunner } from '../runner';

const DATA = '/root/.ethos';
const SCOPE = 'personality:muse';
const LONG =
  'My daughter Priya was born in 2019 and I work as a staff engineer at Acme Corp, and I love tea.';
const FACT_HASH = hashFact('Has a daughter named Priya, born 2019.');

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};

const llm = {
  name: 'fake',
  model: 'fake-model',
  maxContextTokens: 100_000,
  supportsCaching: false,
  supportsThinking: false,
  async *complete() {
    yield { type: 'text_delta' as const, text: 'USER|0.8|Has a daughter named Priya, born 2019.' };
  },
  async countTokens() {
    return 0;
  },
};

const session: SessionStore = {
  getSession: async (id: string) => ({ id, key: `cli:${id}` }) as unknown as Session,
} as unknown as SessionStore;

const ctx: MemoryContext = {
  scopeId: SCOPE,
  sessionId: '',
  sessionKey: '',
  platform: 'cli',
  workingDir: DATA,
};

/** Mirrors `build-agent-loop`'s capture queue for approval `off` + N. */
function harness(evidenceSessions: number) {
  const storage = new InMemoryStorage();
  const provider = new MarkdownFileMemoryProvider({ dir: DATA, storage });
  const history = new HistoryStore({ dataDir: DATA, storage });
  const tombstones = new TombstoneStore({ storage, dataDir: DATA });
  const pending = new PendingMemoryStore({
    storage,
    dataDir: DATA,
    tombstones,
    evidenceSessions,
    autoPromote: true,
    apply: async (entry, approvedBy) => {
      const handle = withHistory(provider, history, {
        source: entry.source,
        approvedBy,
        ...(entry.evidenceSessions && entry.factHash ? { captureHashes: [entry.factHash] } : {}),
      });
      await handle.sync([entry.update], {
        ...ctx,
        sessionId: entry.sessionId ?? '',
        sessionKey: entry.sessionKey ?? 'cli',
      });
    },
  });
  const runner = new MemoryCaptureRunner({
    provider,
    history,
    session,
    llm,
    sanitize: (s) => s,
    logger: NOOP_LOGGER,
    nightlyConfigured: false,
    workingDir: DATA,
    tombstones,
    propose: async (p) => {
      await pending.propose(p);
    },
  });
  const turn = async (sessionId: string) => {
    runner.enqueue({
      sessionId,
      personalityId: 'muse',
      text: 'Congrats!',
      initialPrompt: LONG,
      isDryRun: false,
    });
    await runner.whenIdle();
  };
  const user = async () => (await provider.read('USER.md', ctx))?.content ?? '';
  return { turn, user, pending, history, tombstones };
}

describe('MemoryCaptureRunner — evidence-gated promotion (approval off, N=3)', () => {
  it('holds the fact at 2 sessions and writes it as evidence at 3', async () => {
    const h = harness(3);
    await h.turn('s1');
    await h.turn('s1'); // same session again — not new evidence
    await h.turn('s2');

    expect(await h.user()).not.toContain('Priya');
    const parked = await h.pending.list(SCOPE);
    expect(parked).toHaveLength(1);
    expect(parked[0]?.evidenceSessions).toEqual(['s1', 's2']);

    await h.turn('s3');
    expect(await h.user()).toContain('Priya');
    expect(await h.pending.list(SCOPE)).toHaveLength(0);

    const { entries } = await h.history.read(SCOPE);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe('capture');
    expect(entries[0]?.approvedBy).toBe('evidence');
    expect(entries[0]?.captureHashes).toEqual([FACT_HASH]);
  });

  it('a promoted fact is not queued again by a later session (dedup sees its hash)', async () => {
    const h = harness(3);
    for (const s of ['s1', 's2', 's3']) await h.turn(s);
    await h.turn('s4');
    expect(await h.pending.list(SCOPE)).toHaveLength(0);
    expect((await h.user()).match(/Priya/g)).toHaveLength(1);
  });

  it('a tombstoned hash is never re-queued, however many sessions extract it', async () => {
    const h = harness(3);
    await h.turn('s1');
    const [entry] = await h.pending.list(SCOPE);
    await h.pending.reject(SCOPE, entry?.id ?? '', 'wrong');
    expect(await h.tombstones.has(SCOPE, FACT_HASH)).toBe(true);

    for (const s of ['s2', 's3', 's4']) await h.turn(s);
    expect(await h.pending.list(SCOPE)).toHaveLength(0);
    expect(await h.user()).not.toContain('Priya');
  });
});
