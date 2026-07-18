// Fact lifecycle L4 §4 property: a retracted fact is archived + tombstoned, and
// proactive capture NEVER re-captures it — even after a nightly-style reword.
//
// This is the end-to-end proof across three packages: `retractSlug`
// (@ethosagent/nightly-loop) tombstones via L2's TombstoneStore
// (@ethosagent/memory-approval), and the capture runner's dedup consults that
// same store. The reword is modelled by the extraction returning the fact in
// different casing/spacing — `hashFact` is content-normalized, so the tombstone
// still matches and the fact is dropped before any durable write.

import { join } from 'node:path';
import { TombstoneStore } from '@ethosagent/memory-approval';
import { HistoryStore } from '@ethosagent/memory-history';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { type MemoryMeta, parseMemoryMeta, retractSlug } from '@ethosagent/nightly-loop';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Logger, MemoryContext, Session, SessionStore } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { hashFact } from '../dedup';
import { MemoryCaptureRunner } from '../runner';
import type { CaptureJob } from '../types';

const DATA = '/root/.ethos';
const SCOPE = 'personality:muse';
const SCOPE_DIR = join(DATA, 'personalities', 'muse');
const META_PATH = join(SCOPE_DIR, 'memory-meta.json');

const CANONICAL_FACT = 'Has a daughter named Priya, born 2019.';
// The nightly-style reword: same fact, different casing + spacing. `hashFact`
// normalizes both to the same hash, so the tombstone matches.
const REWORDED_FACT = 'has a  daughter   named   priya, born 2019.';
const LONG =
  'My daughter Priya was born in 2019 and I work as a staff engineer at Acme Corp, and I love tea.';

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};

function makeLlm(factText: string) {
  return {
    name: 'fake',
    model: 'fake-model',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete() {
      yield { type: 'text_delta' as const, text: `USER|0.8|${factText}` };
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

function harness(factText: string) {
  const storage = new InMemoryStorage();
  const provider = new MarkdownFileMemoryProvider({ dir: DATA, storage });
  const history = new HistoryStore({ dataDir: DATA, storage });
  const tombstones = new TombstoneStore({ storage, dataDir: DATA });
  // Ungated: absent `propose`, the runner writes durably UNLESS dedup/tombstone
  // drops the fact first — exactly the path this property exercises.
  const runner = new MemoryCaptureRunner({
    provider,
    history,
    session: makeSession(),
    llm: makeLlm(factText),
    sanitize: (s) => s,
    logger: NOOP_LOGGER,
    nightlyConfigured: true,
    workingDir: DATA,
    tombstones,
  });
  const readMeta = async (): Promise<MemoryMeta> => parseMemoryMeta(await storage.read(META_PATH));
  const writeMeta = async (meta: MemoryMeta): Promise<void> => {
    await storage.mkdir(SCOPE_DIR);
    await storage.writeAtomic(META_PATH, JSON.stringify(meta, null, 2));
  };
  return { storage, provider, history, tombstones, runner, readMeta, writeMeta };
}

describe('L4 property — retract → archive + tombstone → zero re-capture across a reword', () => {
  it('control: an un-retracted fact IS captured (proves the path is live)', async () => {
    const h = harness(CANONICAL_FACT);
    await drain(h.runner);
    expect((await h.provider.read('USER.md', ctx()))?.content ?? '').toContain('Priya');
  });

  it('a retracted fact is archived, tombstoned, and never re-captured after a reword', async () => {
    const h = harness(REWORDED_FACT);
    await h.storage.mkdir(SCOPE_DIR);
    await h.provider.sync(
      [{ action: 'replace', key: 'MEMORY.md', content: `### daughter\n${CANONICAL_FACT}` }],
      ctx(),
    );

    const res = await retractSlug(
      h.provider,
      ctx(),
      'daughter',
      {
        readMeta: h.readMeta,
        writeMeta: h.writeMeta,
        hashFact,
        addTombstone: (hash, reason) => h.tombstones.add(SCOPE, hash, reason),
      },
      'wrong',
    );
    expect(res.ok).toBe(true);

    // Archive entry exists...
    const archive = (await h.provider.read('memory-archive.md', ctx()))?.content ?? '';
    expect(archive).toContain('### daughter');
    expect(archive).toContain('Priya');
    // ...and a tombstone for the canonical fact-hash exists.
    expect(await h.tombstones.has(SCOPE, hashFact(CANONICAL_FACT))).toBe(true);
    // The reworded fact normalizes to the same hash.
    expect(hashFact(REWORDED_FACT)).toBe(hashFact(CANONICAL_FACT));

    // Capture now sees the same fact reworded — it must NOT re-capture it.
    await drain(h.runner);
    expect((await h.provider.read('USER.md', ctx()))?.content ?? '').not.toContain('Priya');
    // No capture history entry was written.
    expect((await h.history.read(SCOPE, { source: 'capture' })).entries).toHaveLength(0);
  });
});
