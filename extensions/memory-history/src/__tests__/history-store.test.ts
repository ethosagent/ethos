import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { HistoryStore } from '../history-store';

const DATA = '/root/.ethos';
const SCOPE = 'personality:muse';

function make(diffCapBytes?: number) {
  const storage = new InMemoryStorage();
  const store = new HistoryStore(
    diffCapBytes !== undefined
      ? { dataDir: DATA, storage, diffCapBytes }
      : { dataDir: DATA, storage },
  );
  return { storage, store };
}

function base(over: Partial<Parameters<HistoryStore['record']>[0]> = {}) {
  return {
    scopeId: SCOPE,
    key: 'MEMORY.md',
    actions: ['add'],
    source: 'tool' as const,
    sessionId: 's1',
    sessionKey: 'cli:test',
    before: '',
    after: 'hello\n',
    ...over,
  };
}

describe('HistoryStore.record', () => {
  it('appends one entry with hashes and sizes', async () => {
    const { store } = make();
    const entry = await store.record(base({ before: '', after: 'hi\n' }));
    expect(entry).not.toBeNull();
    expect(entry?.source).toBe('tool');
    expect(entry?.beforeHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry?.afterHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry?.sizeBefore).toBe(0);
    expect(entry?.sizeAfter).toBe(3);

    const { entries, corruptLines } = await store.read(SCOPE);
    expect(entries).toHaveLength(1);
    expect(corruptLines).toBe(0);
  });

  it('skips no-op mutations (before === after)', async () => {
    const { store } = make();
    const entry = await store.record(base({ before: 'same\n', after: 'same\n' }));
    expect(entry).toBeNull();
    const { entries } = await store.read(SCOPE);
    expect(entries).toHaveLength(0);
  });

  it('spills before-state to a content-addressed blob when the diff exceeds the cap', async () => {
    const { store } = make(50); // tiny cap forces a blob
    const before = 'A'.repeat(4000);
    const entry = await store.record(base({ before, after: 'B\n', actions: ['replace'] }));
    expect(entry?.blob).toBeDefined();
    expect(entry?.diff).toContain('[diff truncated; before-state in blob');
    const blob = entry?.blob ?? '';
    const recovered = await store.readBlob(SCOPE, blob);
    expect(recovered).toBe(before);
  });

  it('resolves the global scope to the data root', async () => {
    const { store } = make();
    await store.record(base({ scopeId: 'global', source: 'global-entry', actions: ['replace'] }));
    expect(store.historyPath('global')).toBe(`${DATA}/memory-history.jsonl`);
    const { entries } = await store.read('global');
    expect(entries).toHaveLength(1);
  });
});

describe('HistoryStore.record — diff-cap boundary (strict >)', () => {
  const before = 'A'.repeat(500);
  const after = 'B'.repeat(500);

  // Measure the untruncated diff length so we can pin the cap to the exact
  // boundary instead of guessing at patch-header overhead.
  async function diffLen(): Promise<number> {
    const { store } = make(10_000_000);
    const e = await store.record(base({ before, after, actions: ['replace'] }));
    return Buffer.byteLength(e?.diff ?? '');
  }

  it('diff exactly at the cap stays inline (no blob)', async () => {
    const L = await diffLen();
    const { store } = make(L); // L > L === false
    const e = await store.record(base({ before, after, actions: ['replace'] }));
    expect(e?.blob).toBeUndefined();
    expect(e?.diff).not.toContain('[diff truncated');
  });

  it('diff one below the cap stays inline (no blob)', async () => {
    const L = await diffLen();
    const { store } = make(L + 1); // L > L+1 === false
    const e = await store.record(base({ before, after, actions: ['replace'] }));
    expect(e?.blob).toBeUndefined();
    expect(e?.diff).not.toContain('[diff truncated');
  });

  it('diff one above the cap spills to a blob, recovered byte-for-byte', async () => {
    const L = await diffLen();
    const { store } = make(L - 1); // L > L-1 === true
    const e = await store.record(base({ before, after, actions: ['replace'] }));
    expect(e?.blob).toBeDefined();
    expect(e?.diff).toContain('[diff truncated; before-state in blob');
    const recovered = await store.readBlob(SCOPE, e?.blob ?? '');
    expect(recovered).toBe(before);
  });
});

describe('HistoryStore.read — tolerant reader', () => {
  it('skips a torn line and reports corruptLines', async () => {
    const { storage, store } = make();
    await store.record(base({ before: '', after: 'one\n' }));
    // Inject a torn/malformed JSONL line directly into the file.
    await storage.append(store.historyPath(SCOPE), '{"ts": 123, "scopeId": "person\n');
    await store.record(base({ before: 'one\n', after: 'one\ntwo\n' }));

    const { entries, corruptLines } = await store.read(SCOPE);
    expect(entries).toHaveLength(2);
    expect(corruptLines).toBe(1);
  });

  it('counts valid-JSON-but-missing-required-fields and {} as corrupt', async () => {
    const { storage, store } = make();
    await store.record(base({ before: '', after: 'one\n' }));
    // Valid JSON, wrong shape: missing `source` (and `{}` missing everything).
    await storage.append(
      store.historyPath(SCOPE),
      '{"ts":123,"scopeId":"personality:muse","key":"MEMORY.md"}\n',
    );
    await storage.append(store.historyPath(SCOPE), '{}\n');

    const { entries, corruptLines } = await store.read(SCOPE);
    expect(entries).toHaveLength(1);
    expect(corruptLines).toBe(2);
  });

  it('filters by key, source and since, and limits to the most recent', async () => {
    const { store } = make();
    await store.record(base({ key: 'MEMORY.md', source: 'tool', before: '', after: 'a\n' }));
    await store.record(base({ key: 'USER.md', source: 'web-editor', before: '', after: 'b\n' }));
    await store.record(base({ key: 'MEMORY.md', source: 'tool', before: 'a\n', after: 'a\nc\n' }));

    const byKey = await store.read(SCOPE, { key: 'USER.md' });
    expect(byKey.entries).toHaveLength(1);
    expect(byKey.entries[0]?.key).toBe('USER.md');

    const bySource = await store.read(SCOPE, { source: 'tool' });
    expect(bySource.entries).toHaveLength(2);

    const limited = await store.read(SCOPE, { limit: 1 });
    expect(limited.entries).toHaveLength(1);
  });
});

describe('HistoryStore.rotate', () => {
  it('moves prior-month entries to an archive file, keeps the current month, reader still sees all', async () => {
    const { storage, store } = make();
    const janTs = new Date(2020, 0, 15).getTime();
    const febTs = new Date(2020, 1, 15).getTime();
    const line = (ts: number, note: string) =>
      `${JSON.stringify({
        ts,
        scopeId: SCOPE,
        key: 'MEMORY.md',
        actions: ['add'],
        source: 'tool',
        sessionId: '',
        sessionKey: '',
        beforeHash: 'sha256:x',
        afterHash: 'sha256:y',
        diff: note,
        sizeBefore: 0,
        sizeAfter: 1,
      })}\n`;
    await storage.mkdir(store.scopeDir(SCOPE));
    await storage.append(store.historyPath(SCOPE), line(janTs, 'jan'));
    await storage.append(store.historyPath(SCOPE), line(febTs, 'feb'));

    const result = await store.rotate(SCOPE, new Date(2020, 1, 20));
    expect(result.rotated).toBe(1);

    const live = await storage.read(store.historyPath(SCOPE));
    expect(live).toContain('feb');
    expect(live).not.toContain('jan');
    const archive = await storage.read(`${store.scopeDir(SCOPE)}/memory-history-2020-01.jsonl`);
    expect(archive).toContain('jan');

    // Reader merges live + archives.
    const { entries } = await store.read(SCOPE);
    expect(entries).toHaveLength(2);
  });

  it('never clobbers appends that land while rotate runs (rename-then-split)', async () => {
    const { storage, store } = make();
    await storage.mkdir(store.scopeDir(SCOPE));

    // Seed OLD-month entries so rotate has real work and must move the inode.
    const janTs = new Date(2020, 0, 15).getTime();
    const OLD = 5;
    const oldLine = (i: number) =>
      `${JSON.stringify({
        ts: janTs,
        scopeId: SCOPE,
        key: 'MEMORY.md',
        actions: ['add'],
        source: 'tool',
        sessionId: '',
        sessionKey: '',
        beforeHash: 'sha256:x',
        afterHash: 'sha256:y',
        diff: `old-${i}`,
        sizeBefore: 0,
        sizeAfter: 1,
      })}\n`;
    for (let i = 0; i < OLD; i++) await storage.append(store.historyPath(SCOPE), oldLine(i));

    // N workers each append K current-month entries concurrently WITH rotate.
    // Under InMemoryStorage the awaits interleave, so appends land in the
    // read→rename→re-append window that read-modify-writeAtomic would clobber.
    const nowD = new Date(2020, 1, 20);
    const nowTs = nowD.getTime();
    const N = 4;
    const K = 25;
    const curLine = (w: number, k: number) =>
      `${JSON.stringify({
        ts: nowTs,
        scopeId: SCOPE,
        key: 'MEMORY.md',
        actions: ['add'],
        source: 'capture',
        sessionId: '',
        sessionKey: '',
        beforeHash: 'sha256:x',
        afterHash: 'sha256:y',
        diff: `w${w}-k${k}`,
        sizeBefore: 0,
        sizeAfter: 1,
      })}\n`;
    const worker = async (w: number) => {
      for (let k = 0; k < K; k++) await storage.append(store.historyPath(SCOPE), curLine(w, k));
    };

    await Promise.all([
      store.rotate(SCOPE, nowD),
      ...Array.from({ length: N }, (_, w) => worker(w)),
    ]);

    const { entries } = await store.read(SCOPE);
    // Every OLD entry (archived) + every concurrently-appended current entry
    // survives — nothing dropped by the rotation.
    expect(entries).toHaveLength(OLD + N * K);
    const diffs = new Set(entries.map((e) => e.diff));
    for (let w = 0; w < N; w++) {
      for (let k = 0; k < K; k++) expect(diffs.has(`w${w}-k${k}`)).toBe(true);
    }
    // The temporary snapshot is cleaned up.
    expect(await storage.exists(`${store.historyPath(SCOPE)}.rotating`)).toBe(false);
  });
});
