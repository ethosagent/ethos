import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { BlobStore } from '../blob-store';

const ROOT = '/blobs';

describe('BlobStore', () => {
  let storage: InMemoryStorage;
  let store: BlobStore;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    await storage.mkdir(ROOT);
    store = new BlobStore(ROOT, storage);
  });

  it('stores and retrieves content round-trip', async () => {
    const content = 'Hello, world! This is a test blob.';
    const key = await store.put(content);
    const result = await store.get(key);
    expect(result).toBe(content);
  });

  it('returns null for unknown key', async () => {
    const result = await store.get('0'.repeat(64));
    expect(result).toBeNull();
  });

  it('is content-addressed: same content yields same key', async () => {
    const content = 'identical content';
    const key1 = await store.put(content);
    const key2 = await store.put(content);
    expect(key1).toBe(key2);
  });

  it('different content yields different keys', async () => {
    const key1 = await store.put('content a');
    const key2 = await store.put('content b');
    expect(key1).not.toBe(key2);
  });

  it('key is a 64-char hex SHA-256', async () => {
    const key = await store.put('test');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('put is idempotent: does not throw on second write', async () => {
    const content = 'idempotent content';
    await store.put(content);
    await expect(store.put(content)).resolves.toBeDefined();
  });

  it('stores blobs sharded by first two chars', async () => {
    const content = 'shard test content';
    const key = await store.put(content);
    const prefix = key.slice(0, 2);
    const entries = await storage.list(`${ROOT}/${prefix}`);
    expect(entries).toContain(`${key}.gz`);
  });

  it('handles unicode content', async () => {
    const content = 'こんにちは 🌸 émoji test';
    const key = await store.put(content);
    const result = await store.get(key);
    expect(result).toBe(content);
  });
});
