import { DefaultLLMProviderRegistry } from '@ethosagent/core';
import { OPENAI_COMPAT_ALIASES } from '@ethosagent/llm-openai-compat';
import type { Logger, SecretsResolver } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { getProvider } from '../provider-catalog';
import { registerBuiltinProviders } from '../register-builtin-providers';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

const noopSecrets: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};

describe('provider catalog — local presets', () => {
  it('exposes a vllm preset routing through openai-compat with a localhost default', () => {
    const vllm = getProvider('vllm');
    expect(vllm).toBeDefined();
    expect(vllm?.authType).toBe('self-hosted');
    expect(vllm?.costType).toBe('local');
    expect(vllm?.defaultBaseUrl).toBe('http://localhost:8000/v1');
    expect(vllm?.comingSoon).toBeUndefined();
    // "right transport" — the preset is served by the openai-compat provider.
    expect(OPENAI_COMPAT_ALIASES).toContain('vllm');
  });

  it('ships ollama as GA (no longer comingSoon)', () => {
    const ollama = getProvider('ollama');
    expect(ollama).toBeDefined();
    expect(ollama?.comingSoon).toBeUndefined();
    expect(ollama?.defaultBaseUrl).toBe('http://localhost:11434/v1');
  });
});

describe('register-builtin-providers — vllm', () => {
  it('registers vllm as an openai-compat provider', () => {
    const registry = new DefaultLLMProviderRegistry();
    registerBuiltinProviders(registry);
    expect(registry.list()).toContain('vllm');
  });

  it('accepts a localhost base URL through the SSRF gate', async () => {
    const registry = new DefaultLLMProviderRegistry();
    registerBuiltinProviders(registry);
    const factory = registry.get('vllm');
    if (!factory) throw new Error('Expected vllm factory to be registered');

    const provider = await factory({
      config: {
        provider: 'vllm',
        model: 'qwen2.5',
        apiKey: 'local',
        baseUrl: 'http://localhost:8000/v1',
      },
      secrets: noopSecrets,
      logger: noopLogger,
    });

    expect(provider.name).toBe('vllm');
    expect(provider.model).toBe('qwen2.5');
  });

  it('blocks a cloud-metadata base URL via the SSRF gate', async () => {
    const registry = new DefaultLLMProviderRegistry();
    registerBuiltinProviders(registry);
    const factory = registry.get('vllm');
    if (!factory) throw new Error('Expected vllm factory to be registered');

    await expect(
      factory({
        config: {
          provider: 'vllm',
          model: 'qwen2.5',
          apiKey: 'local',
          baseUrl: 'http://169.254.169.254/v1',
        },
        secrets: noopSecrets,
        logger: noopLogger,
      }),
    ).rejects.toThrow(/SSRF/);
  });
});
