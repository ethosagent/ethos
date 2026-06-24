import type { MemoryProvider, MemoryProviderFactory } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { DefaultMemoryProviderRegistry } from '../providers/memory-registry';

const factory: MemoryProviderFactory = async () => ({}) as unknown as MemoryProvider;

describe('DefaultMemoryProviderRegistry', () => {
  it('register + get + list', () => {
    const reg = new DefaultMemoryProviderRegistry();
    reg.register('a', factory);
    expect(reg.get('a')).toBe(factory);
    expect(reg.list()).toEqual(['a']);
  });

  it('throws on duplicate registration', () => {
    const reg = new DefaultMemoryProviderRegistry();
    reg.register('a', factory);
    expect(() => reg.register('a', factory)).toThrow('already registered');
  });

  it('unregister removes the factory; re-register does not throw; idempotent on absent', () => {
    const reg = new DefaultMemoryProviderRegistry();
    reg.register('a', factory);
    reg.unregister('a');
    expect(reg.get('a')).toBeUndefined();
    expect(reg.list()).not.toContain('a');
    expect(() => reg.register('a', factory)).not.toThrow();
    expect(() => reg.unregister('absent')).not.toThrow();
  });
});
