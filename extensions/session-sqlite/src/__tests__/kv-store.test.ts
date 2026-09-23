import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKvStoreFactory } from '../index';
import { SqliteKeyValueStore } from '../kv-store';
import { holdWriteLock } from './hold-write-lock';

describe('SqliteKeyValueStore', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    SqliteKeyValueStore.migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  function makeStore(tool = 'test-tool', scopeId = 'scope-1') {
    return new SqliteKeyValueStore(db, tool, scopeId);
  }

  it('get returns null for missing key', async () => {
    const store = makeStore();
    expect(await store.get('nonexistent')).toBeNull();
  });

  it('set + get round-trip', async () => {
    const store = makeStore();
    await store.set('color', 'blue');
    expect(await store.get('color')).toBe('blue');
  });

  it('set overwrites existing value', async () => {
    const store = makeStore();
    await store.set('color', 'blue');
    await store.set('color', 'red');
    expect(await store.get('color')).toBe('red');
  });

  it('delete removes the key', async () => {
    const store = makeStore();
    await store.set('color', 'blue');
    await store.delete('color');
    expect(await store.get('color')).toBeNull();
  });

  it('list returns keys matching prefix', async () => {
    const store = makeStore();
    await store.set('user:name', 'Alice');
    await store.set('user:age', '30');
    await store.set('config:theme', 'dark');
    const keys = await store.list('user:');
    expect(keys.sort()).toEqual(['user:age', 'user:name']);
  });

  it('list with empty prefix returns all keys', async () => {
    const store = makeStore();
    await store.set('a', '1');
    await store.set('b', '2');
    const keys = await store.list('');
    expect(keys.sort()).toEqual(['a', 'b']);
  });

  describe('TTL', () => {
    it('returns value before expiry', async () => {
      const store = makeStore();
      await store.set('temp', 'val', { ttlSeconds: 60 });
      expect(await store.get('temp')).toBe('val');
    });

    it('returns null after expiry', async () => {
      const store = makeStore();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      await store.set('temp', 'val', { ttlSeconds: 10 });

      vi.spyOn(Date, 'now').mockReturnValue(now + 11_000);
      expect(await store.get('temp')).toBeNull();
      vi.restoreAllMocks();
    });

    it('expired keys are not returned by list', async () => {
      const store = makeStore();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      await store.set('alive', 'yes', { ttlSeconds: 60 });
      await store.set('dead', 'yes', { ttlSeconds: 1 });

      vi.spyOn(Date, 'now').mockReturnValue(now + 2_000);
      const keys = await store.list('');
      expect(keys).toEqual(['alive']);
      vi.restoreAllMocks();
    });
  });

  describe('isolation', () => {
    it('different tools are isolated', async () => {
      const storeA = makeStore('tool-a', 'scope-1');
      const storeB = makeStore('tool-b', 'scope-1');
      await storeA.set('key', 'from-a');
      await storeB.set('key', 'from-b');
      expect(await storeA.get('key')).toBe('from-a');
      expect(await storeB.get('key')).toBe('from-b');
    });

    it('different scope_ids are isolated', async () => {
      const storeA = makeStore('test-tool', 'scope-1');
      const storeB = makeStore('test-tool', 'scope-2');
      await storeA.set('key', 'from-1');
      await storeB.set('key', 'from-2');
      expect(await storeA.get('key')).toBe('from-1');
      expect(await storeB.get('key')).toBe('from-2');
    });
  });
});

// The factory's handle is a closure, so contention is the only observable of
// its busy_timeout (plan hermes-0.21.4-fixes Fix 1).
describe('createKvStoreFactory — a peer process holding the write lock', () => {
  it('set waits for the peer instead of throwing SQLITE_BUSY', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-store-busy-'));
    try {
      const dbPath = join(dir, 'sessions.db');
      const factory = createKvStoreFactory(dbPath);
      const store = factory('t', 's');
      const holder = await holdWriteLock(dbPath);
      // Runs while the peer holds the write lock. Pre-fix this threw.
      await store.set('k', 'v');
      expect(await store.get('k')).toBe('v');
      factory.close();
      await holder.terminate();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
