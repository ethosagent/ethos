import type { Storage } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThreadStateStore } from '../store/thread-state';

function createInMemoryStorage(): Storage {
  const files = new Map<string, string>();
  return {
    read: async (path: string) => files.get(path) ?? null,
    write: async (path: string, content: string) => {
      files.set(path, content);
    },
    append: async (path: string, content: string) => {
      const existing = files.get(path) ?? '';
      files.set(path, existing + content);
    },
    exists: async (path: string) => files.has(path),
    mkdir: async () => {},
    mtime: async () => null,
    list: async () => [],
    listEntries: async () => [],
    writeAtomic: async (path: string, content: string) => {
      files.set(path, content);
    },
    readBytes: async () => null,
    remove: async (path: string) => {
      files.delete(path);
    },
    rename: async () => {},
    chmod: async () => {},
  };
}

describe('ThreadStateStore', () => {
  let store: ThreadStateStore;
  let storage: Storage;

  beforeEach(() => {
    storage = createInMemoryStorage();
    store = new ThreadStateStore(storage, 'discord', 'bot123');
  });

  it('initially reports no threads', async () => {
    await store.load();
    expect(store.hasBotPosted('channel1', 'thread1')).toBe(false);
  });

  it('records a thread post and reports it', async () => {
    await store.recordPost('channel1', 'thread1');
    expect(store.hasBotPosted('channel1', 'thread1')).toBe(true);
  });

  it('different threads are independent', async () => {
    await store.recordPost('channel1', 'thread1');
    expect(store.hasBotPosted('channel1', 'thread2')).toBe(false);
  });

  it('persists across store instances', async () => {
    await store.recordPost('channel1', 'thread1');
    const store2 = new ThreadStateStore(storage, 'discord', 'bot123');
    await store2.load();
    expect(store2.hasBotPosted('channel1', 'thread1')).toBe(true);
  });

  it('does not duplicate writes for same key', async () => {
    await store.recordPost('channel1', 'thread1');
    await store.recordPost('channel1', 'thread1');
    const file = await storage.read('discord/bot123/thread-state.jsonl');
    const lines = file?.split('\n').filter(Boolean) ?? [];
    expect(lines).toHaveLength(1);
  });

  it('skips corrupted lines and loads valid ones', async () => {
    const valid = JSON.stringify({ channel: 'ch1', threadId: 't1', firstPostedAt: 1 });
    await storage.write('discord/bot123/thread-state.jsonl', `not valid json\n${valid}\n{broken\n`);
    const freshStore = new ThreadStateStore(storage, 'discord', 'bot123');
    await freshStore.load();
    expect(freshStore.hasBotPosted('ch1', 't1')).toBe(true);
  });
});
