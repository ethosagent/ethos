import type { LLMProvider, LLMProviderFactory } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { DefaultLLMProviderRegistry } from '../providers/llm-registry';

const factory: LLMProviderFactory = async () => ({}) as unknown as LLMProvider;

describe('DefaultLLMProviderRegistry', () => {
  it('register + get + list', () => {
    const reg = new DefaultLLMProviderRegistry();
    reg.register('a', factory);
    expect(reg.get('a')).toBe(factory);
    expect(reg.list()).toEqual(['a']);
  });

  it('throws on duplicate registration', () => {
    const reg = new DefaultLLMProviderRegistry();
    reg.register('a', factory);
    expect(() => reg.register('a', factory)).toThrow('already registered');
  });

  it('unregister removes the factory; re-register does not throw; idempotent on absent', () => {
    const reg = new DefaultLLMProviderRegistry();
    reg.register('a', factory);
    reg.unregister('a');
    expect(reg.get('a')).toBeUndefined();
    expect(reg.list()).not.toContain('a');
    expect(() => reg.register('a', factory)).not.toThrow();
    expect(() => reg.unregister('absent')).not.toThrow();
  });
});
