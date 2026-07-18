import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  GlobalMemoryEntry,
  GlobalMemoryStore,
  MemoryContext,
  MemoryEntry,
  MemoryProvider,
  MemorySnapshot,
  MemoryUpdate,
} from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { isGated, PendingMemoryGate, withPendingGate } from '../gate';
import { PendingMemoryStore, TombstoneStore } from '../store';

const DATA_DIR = '/data';
const SCOPE = 'personality:default';

/** A minimal provider that records the syncs that reach it. */
class RecordingProvider implements MemoryProvider, GlobalMemoryStore {
  readonly synced: Array<{ updates: MemoryUpdate[]; ctx: MemoryContext }> = [];
  async prefetch(): Promise<MemorySnapshot | null> {
    return null;
  }
  async read(): Promise<MemoryEntry | null> {
    return null;
  }
  async search(): Promise<MemoryEntry[]> {
    return [];
  }
  async list(): Promise<[]> {
    return [];
  }
  async sync(updates: MemoryUpdate[], ctx: MemoryContext): Promise<void> {
    this.synced.push({ updates, ctx });
  }
  async readGlobalEntry(): Promise<GlobalMemoryEntry> {
    return { content: '', path: null, modifiedAt: null };
  }
  async writeGlobalEntry(_store: 'memory' | 'user', content: string): Promise<GlobalMemoryEntry> {
    this.synced.push({
      updates: [{ action: 'replace', key: 'GLOBAL', content }],
      ctx: baseCtx(),
    });
    return { content, path: null, modifiedAt: null };
  }
}

function baseCtx(overrides?: Partial<MemoryContext>): MemoryContext {
  return {
    scopeId: SCOPE,
    sessionId: 's1',
    sessionKey: 'cli:proj',
    platform: 'cli',
    workingDir: '/w',
    ...overrides,
  };
}

describe('isGated', () => {
  it('off gates nothing', () => {
    expect(isGated('capture', 'off')).toBe(false);
    expect(isGated('tool', 'off')).toBe(false);
  });
  it('automated gates capture + dream only', () => {
    expect(isGated('capture', 'automated')).toBe(true);
    expect(isGated('dream', 'automated')).toBe(true);
    expect(isGated('tool', 'automated')).toBe(false);
    expect(isGated('consolidation', 'automated')).toBe(false);
  });
  it('all gates every source', () => {
    expect(isGated('tool', 'all')).toBe(true);
    expect(isGated('consolidation', 'all')).toBe(true);
  });
});

describe('PendingMemoryGate', () => {
  let storage: InMemoryStorage;
  let store: PendingMemoryStore;

  beforeEach(() => {
    storage = new InMemoryStorage();
    const tombstones = new TombstoneStore({ storage, dataDir: DATA_DIR });
    store = new PendingMemoryStore({
      storage,
      dataDir: DATA_DIR,
      tombstones,
      apply: async () => {},
    });
  });

  it('mode: off is a pure pass-through — no queueing', async () => {
    const inner = new RecordingProvider();
    const gate = withPendingGate(inner, { store, mode: 'off', source: 'tool' });
    // withPendingGate returns the inner untouched in off mode.
    expect(gate).toBe(inner);

    await gate.sync([{ action: 'add', key: 'MEMORY.md', content: 'x' }], baseCtx());
    expect(inner.synced).toHaveLength(1);
    expect(await store.list(SCOPE)).toHaveLength(0);
  });

  it('a non-gated source passes straight through', async () => {
    const inner = new RecordingProvider();
    const gate = new PendingMemoryGate(inner, { store, mode: 'automated', source: 'tool' });
    await gate.sync([{ action: 'add', key: 'MEMORY.md', content: 'x' }], baseCtx());
    expect(inner.synced).toHaveLength(1);
    expect(await store.list(SCOPE)).toHaveLength(0);
  });

  it('a gated dream turn (relabelled from sessionKey) is parked, not written', async () => {
    const inner = new RecordingProvider();
    const gate = new PendingMemoryGate(inner, { store, mode: 'automated', source: 'tool' });
    await gate.sync(
      [{ action: 'add', key: 'MEMORY.md', content: 'dreamt fact' }],
      baseCtx({ sessionKey: 'dream:nightly' }),
    );
    expect(inner.synced).toHaveLength(0);
    const pending = await store.list(SCOPE);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.source).toBe('dream');
  });

  it('gates every source in mode: all', async () => {
    const inner = new RecordingProvider();
    const gate = new PendingMemoryGate(inner, { store, mode: 'all', source: 'tool' });
    await gate.sync([{ action: 'add', key: 'MEMORY.md', content: 'tool edit' }], baseCtx());
    expect(inner.synced).toHaveLength(0);
    expect(await store.list(SCOPE)).toHaveLength(1);
  });

  it('never gates writeGlobalEntry, even in mode: all', async () => {
    const inner = new RecordingProvider();
    const gate = new PendingMemoryGate(inner, { store, mode: 'all', source: 'tool' });
    const res = await gate.writeGlobalEntry('memory', 'human save');
    expect(res.content).toBe('human save');
    expect(inner.synced).toHaveLength(1);
    expect(await store.list(SCOPE)).toHaveLength(0);
  });
});
