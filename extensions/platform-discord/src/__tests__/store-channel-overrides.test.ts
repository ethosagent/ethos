import { beforeEach, describe, expect, it } from 'vitest';
import { ChannelOverrideStore } from '../store/channel-overrides';

function createInMemoryStorage() {
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

describe('ChannelOverrideStore', () => {
  let store: ChannelOverrideStore;
  let storage: ReturnType<typeof createInMemoryStorage>;

  beforeEach(() => {
    storage = createInMemoryStorage();
    store = new ChannelOverrideStore(storage as any, 'discord', 'bot123');
  });

  it('returns undefined for unknown channels', async () => {
    await store.load();
    expect(store.get('unknown-channel')).toBeUndefined();
  });

  it('stores and retrieves a channel mode override', async () => {
    await store.set('ch1', 'all');
    expect(store.get('ch1')).toBe('all');
  });

  it('latest set wins for a given channel', async () => {
    await store.set('ch1', 'mention_only');
    await store.set('ch1', 'thread_follow');
    expect(store.get('ch1')).toBe('thread_follow');
  });

  it('persists across store instances', async () => {
    await store.set('ch1', 'all');
    const store2 = new ChannelOverrideStore(storage as any, 'discord', 'bot123');
    await store2.load();
    expect(store2.get('ch1')).toBe('all');
  });

  it('entries returns all channel mode pairs', async () => {
    await store.set('ch1', 'all');
    await store.set('ch2', 'mention_only');
    const entries = store.entries();
    expect(entries).toContainEqual(['ch1', 'all']);
    expect(entries).toContainEqual(['ch2', 'mention_only']);
  });
});
