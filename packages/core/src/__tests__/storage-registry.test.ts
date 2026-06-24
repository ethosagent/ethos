import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { DefaultStorageRegistry } from '../providers/storage-registry';

const noopCtx = {
  config: {},
  secrets: {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    list: async () => [] as string[],
  },
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => noopCtx.logger,
  },
};

describe('DefaultStorageRegistry', () => {
  it('register + resolve returns the backend', async () => {
    const registry = new DefaultStorageRegistry();
    registry.register('memory', () => new InMemoryStorage());
    const backend = await registry.resolve('memory', noopCtx);
    expect(backend).toBeInstanceOf(InMemoryStorage);
  });

  it('resolve caches instances', async () => {
    const registry = new DefaultStorageRegistry();
    registry.register('memory', () => new InMemoryStorage());
    const a = await registry.resolve('memory', noopCtx);
    const b = await registry.resolve('memory', noopCtx);
    expect(a).toBe(b);
  });

  it('register throws on duplicate', () => {
    const registry = new DefaultStorageRegistry();
    registry.register('memory', () => new InMemoryStorage());
    expect(() => registry.register('memory', () => new InMemoryStorage())).toThrow(
      'already registered',
    );
  });

  it('resolve throws on unknown backend', async () => {
    const registry = new DefaultStorageRegistry();
    await expect(registry.resolve('unknown', noopCtx)).rejects.toThrow('not registered');
  });

  it('list returns registered names', () => {
    const registry = new DefaultStorageRegistry();
    registry.register('a', () => new InMemoryStorage());
    registry.register('b', () => new InMemoryStorage());
    expect(registry.list()).toEqual(['a', 'b']);
  });

  it('get returns undefined before resolve', () => {
    const registry = new DefaultStorageRegistry();
    registry.register('memory', () => new InMemoryStorage());
    expect(registry.get('memory')).toBeUndefined();
  });

  it('get returns instance after resolve', async () => {
    const registry = new DefaultStorageRegistry();
    registry.register('memory', () => new InMemoryStorage());
    const instance = await registry.resolve('memory', noopCtx);
    expect(registry.get('memory')).toBe(instance);
  });

  it('unregister clears factory and cached instance; re-register does not throw', async () => {
    const registry = new DefaultStorageRegistry();
    registry.register('memory', () => new InMemoryStorage());
    await registry.resolve('memory', noopCtx);
    expect(registry.get('memory')).toBeDefined();
    registry.unregister('memory');
    expect(registry.get('memory')).toBeUndefined();
    expect(registry.list()).not.toContain('memory');
    expect(() => registry.register('memory', () => new InMemoryStorage())).not.toThrow();
    expect(() => registry.unregister('absent')).not.toThrow();
  });
});
