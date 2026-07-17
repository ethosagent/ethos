import { DefaultLLMProviderRegistry } from '@ethosagent/core';
import type { Logger, SecretsResolver } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { lookupContextWindow } from '../model-catalog';
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

describe('M1b — catalog context-window lookup', () => {
  const noop: SecretsResolver = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    list: async () => [],
  };

  it('lookupContextWindow returns the catalog window on a hit', () => {
    // Ollama's llama3.2 declares a realistic 128k context window in the catalog.
    expect(lookupContextWindow('ollama', 'llama3.2')).toBe(131_072);
  });

  it('lookupContextWindow returns undefined on a miss', () => {
    expect(lookupContextWindow('ollama', 'no-such-model')).toBeUndefined();
    expect(lookupContextWindow('no-such-provider', 'llama3.2')).toBeUndefined();
  });

  it('config-only factory sizes maxContextTokens from the catalog (8k model)', async () => {
    const registry = new DefaultLLMProviderRegistry();
    registerBuiltinProviders(registry);
    const factory = registry.get('fireworks');
    if (!factory) throw new Error('Expected fireworks factory to be registered');

    // firefunction-v2 is an 8k-context entry in MODEL_CATALOG under `fireworks`.
    const provider = await factory({
      config: { model: 'accounts/fireworks/models/firefunction-v2', apiKey: 'test-key' },
      secrets: noop,
      logger: noopLogger,
    });

    expect(provider.maxContextTokens).toBe(8_192);
  });

  it('miss path falls back to the provider default (128k), no crash', async () => {
    const registry = new DefaultLLMProviderRegistry();
    registerBuiltinProviders(registry);
    const factory = registry.get('fireworks');
    if (!factory) throw new Error('Expected fireworks factory to be registered');

    // A model absent from the catalog → lookup miss → provider 128k default.
    const provider = await factory({
      config: { model: 'accounts/fireworks/models/not-in-catalog', apiKey: 'test-key' },
      secrets: noop,
      logger: noopLogger,
    });

    expect(provider.maxContextTokens).toBe(128_000);
  });

  it('an explicit config.maxContextTokens wins over the catalog', async () => {
    const registry = new DefaultLLMProviderRegistry();
    registerBuiltinProviders(registry);
    const factory = registry.get('fireworks');
    if (!factory) throw new Error('Expected fireworks factory to be registered');

    const provider = await factory({
      config: {
        model: 'accounts/fireworks/models/firefunction-v2',
        apiKey: 'test-key',
        maxContextTokens: 4_096,
      },
      secrets: noop,
      logger: noopLogger,
    });

    expect(provider.maxContextTokens).toBe(4_096);
  });
});
