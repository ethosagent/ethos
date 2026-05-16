import type { LLMProvider, MemoryProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { DefaultLLMProviderRegistry } from '../providers/llm-registry';
import { DefaultMemoryProviderRegistry } from '../providers/memory-registry';

describe('DefaultLLMProviderRegistry', () => {
  it('registers and retrieves a factory', () => {
    const registry = new DefaultLLMProviderRegistry();
    const factory = () => ({}) as unknown as LLMProvider;
    registry.register('test', factory);
    expect(registry.get('test')).toBe(factory);
  });

  it('returns undefined for unknown names', () => {
    const registry = new DefaultLLMProviderRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('lists registered provider names', () => {
    const registry = new DefaultLLMProviderRegistry();
    registry.register('alpha', () => ({}) as unknown as LLMProvider);
    registry.register('beta', () => ({}) as unknown as LLMProvider);
    expect(registry.list()).toEqual(['alpha', 'beta']);
  });

  it('throws on duplicate name registration', () => {
    const registry = new DefaultLLMProviderRegistry();
    registry.register('dup', () => ({}) as unknown as LLMProvider);
    expect(() => registry.register('dup', () => ({}) as unknown as LLMProvider)).toThrow(
      'LLM provider "dup" is already registered',
    );
  });
});

describe('DefaultMemoryProviderRegistry', () => {
  it('registers and retrieves a factory', () => {
    const registry = new DefaultMemoryProviderRegistry();
    const factory = () => ({}) as unknown as MemoryProvider;
    registry.register('test', factory);
    expect(registry.get('test')).toBe(factory);
  });

  it('returns undefined for unknown names', () => {
    const registry = new DefaultMemoryProviderRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('lists registered provider names', () => {
    const registry = new DefaultMemoryProviderRegistry();
    registry.register('markdown', () => ({}) as unknown as MemoryProvider);
    registry.register('vector', () => ({}) as unknown as MemoryProvider);
    expect(registry.list()).toEqual(['markdown', 'vector']);
  });

  it('throws on duplicate name registration', () => {
    const registry = new DefaultMemoryProviderRegistry();
    registry.register('dup', () => ({}) as unknown as MemoryProvider);
    expect(() => registry.register('dup', () => ({}) as unknown as MemoryProvider)).toThrow(
      'Memory provider "dup" is already registered',
    );
  });
});
