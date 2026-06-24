import { InMemoryStorage, ScopedStorage } from '@ethosagent/storage-fs';
import { BoundaryError } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';

describe('Storage scoping', () => {
  it('personality always receives ScopedStorage-wrapped backend', async () => {
    const raw = new InMemoryStorage();
    const scoped = new ScopedStorage(raw, {
      read: ['/allowed'],
      write: ['/allowed'],
    });

    await scoped.mkdir('/allowed');
    await scoped.write('/allowed/test.txt', 'hello');
    const content = await scoped.read('/allowed/test.txt');
    expect(content).toBe('hello');
  });

  it('out-of-scope reads throw BoundaryError', async () => {
    const raw = new InMemoryStorage();
    await raw.mkdir('/forbidden');
    await raw.write('/forbidden/secret.txt', 'secret');

    const scoped = new ScopedStorage(raw, {
      read: ['/allowed'],
      write: ['/allowed'],
    });

    await expect(scoped.read('/forbidden/secret.txt')).rejects.toThrow(BoundaryError);
  });

  it('out-of-scope writes throw BoundaryError', async () => {
    const raw = new InMemoryStorage();
    const scoped = new ScopedStorage(raw, {
      read: ['/allowed'],
      write: ['/allowed'],
    });

    await expect(scoped.write('/forbidden/test.txt', 'data')).rejects.toThrow(BoundaryError);
  });
});
