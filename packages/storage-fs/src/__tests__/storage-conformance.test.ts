import { BoundaryError, type Storage } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { InMemoryStorage, ScopedStorage } from '../index';

export function runStorageConformance(name: string, factory: () => Storage): void {
  describe(`Storage conformance: ${name}`, () => {
    it('writeAtomic is all-or-nothing: content matches on read-back', async () => {
      const storage = factory();
      await storage.mkdir('/test');
      await storage.writeAtomic('/test/atomic.txt', 'hello world');
      const content = await storage.read('/test/atomic.txt');
      expect(content).toBe('hello world');
    });

    it('read returns null on missing file', async () => {
      const storage = factory();
      const content = await storage.read('/nonexistent');
      expect(content).toBeNull();
    });

    it('exists returns false on missing file', async () => {
      const storage = factory();
      const exists = await storage.exists('/nonexistent');
      expect(exists).toBe(false);
    });

    it('mtime returns null on missing file', async () => {
      const storage = factory();
      const mtime = await storage.mtime('/nonexistent');
      expect(mtime).toBeNull();
    });

    it('chmod does not throw (no-op for non-POSIX)', async () => {
      const storage = factory();
      await storage.mkdir('/test');
      await storage.write('/test/file.txt', 'data');
      await expect(storage.chmod('/test/file.txt', 0o600)).resolves.not.toThrow();
    });

    it('BoundaryError passthrough when wrapped in ScopedStorage', async () => {
      const storage = factory();
      const scoped = new ScopedStorage(storage, {
        read: ['/allowed'],
        write: ['/allowed'],
      });
      await expect(scoped.read('/forbidden/file.txt')).rejects.toThrow(BoundaryError);
    });
  });
}

runStorageConformance('InMemoryStorage', () => new InMemoryStorage());
