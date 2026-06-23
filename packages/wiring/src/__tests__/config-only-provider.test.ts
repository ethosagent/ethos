import { DefaultLLMProviderRegistry } from '@ethosagent/core';
import type { Logger, SecretsResolver } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { registerBuiltinProviders } from '../register-builtin-providers';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

describe('config-only providers', () => {
  it('registers together/fireworks/mistral from manifests', () => {
    const registry = new DefaultLLMProviderRegistry();
    registerBuiltinProviders(registry);
    const providers = registry.list();
    expect(providers).toContain('together');
    expect(providers).toContain('fireworks');
    expect(providers).toContain('mistral');
  });

  it('config-only factory creates a provider with capabilities', async () => {
    const registry = new DefaultLLMProviderRegistry();
    registerBuiltinProviders(registry);
    const factory = registry.get('together');
    if (!factory) throw new Error('Expected together factory to be registered');

    const noop: SecretsResolver = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };
    const provider = await factory({
      config: { model: 'meta-llama/Llama-4-Scout-17B-16E-Instruct', apiKey: 'test-key' },
      secrets: noop,
      logger: noopLogger,
    });

    expect(provider.name).toBe('together');
    expect(provider.model).toBe('meta-llama/Llama-4-Scout-17B-16E-Instruct');
    expect(provider.capabilities).toBeDefined();
    expect(provider.capabilities?.streaming).toBe(true);
    expect(provider.capabilities?.toolCalling).toBe(true);
  });

  it('throws when no API key is available', async () => {
    const registry = new DefaultLLMProviderRegistry();
    registerBuiltinProviders(registry);
    const factory = registry.get('together');
    if (!factory) throw new Error('Expected together factory to be registered');

    const noop: SecretsResolver = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };

    await expect(
      factory({
        config: { model: 'some-model' },
        secrets: noop,
        logger: noopLogger,
      }),
    ).rejects.toThrow('requires an API key');
  });

  it('throws when no model is specified', async () => {
    const registry = new DefaultLLMProviderRegistry();
    registerBuiltinProviders(registry);
    const factory = registry.get('together');
    if (!factory) throw new Error('Expected together factory to be registered');

    const noop: SecretsResolver = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };

    await expect(
      factory({
        config: { apiKey: 'test-key' },
        secrets: noop,
        logger: noopLogger,
      }),
    ).rejects.toThrow('requires a model');
  });

  it('uses defaultModel from manifest when config.model is absent', async () => {
    const registry = new DefaultLLMProviderRegistry();
    registerBuiltinProviders(registry);
    const factory = registry.get('mistral');
    if (!factory) throw new Error('Expected mistral factory to be registered');

    const noop: SecretsResolver = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };
    const provider = await factory({
      config: { apiKey: 'test-key' },
      secrets: noop,
      logger: noopLogger,
    });

    expect(provider.model).toBe('mistral-large-latest');
  });
});
