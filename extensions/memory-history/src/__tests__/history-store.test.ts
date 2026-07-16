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
});
