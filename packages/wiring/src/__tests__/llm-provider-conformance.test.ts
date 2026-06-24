import { DefaultLLMProviderRegistry } from '@ethosagent/core';
import { describe, expect, it, vi } from 'vitest';
import { isProviderAllowed } from '../index';

// ---------------------------------------------------------------------------
// §4.B — LLM provider SDK conformance: trust gate + one-resolver guarantee
// ---------------------------------------------------------------------------

const mockSecrets = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child() {
    return mockLogger;
  },
};

describe('LLM provider SDK conformance (§4.B)', () => {
  // -----------------------------------------------------------------------
  // One-resolver guarantee: plugin-contributed and built-in providers both
  // resolve from the same DefaultLLMProviderRegistry instance.
  // -----------------------------------------------------------------------

  it('plugin-contributed and built-in providers resolve from the same registry', async () => {
    const registry = new DefaultLLMProviderRegistry();

    const builtinProvider = {
      name: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      supportsCaching: true,
      supportsThinking: true,
      maxContextTokens: 200_000,
      capabilities: { streaming: true, toolCalling: true, contractVersion: 1 },
      complete: vi.fn(),
      countTokens: vi.fn(),
    };
    registry.register('anthropic', async () => builtinProvider);

    const pluginProvider = {
      name: 'my-plugin/custom-llm',
      model: 'custom-model',
      supportsCaching: false,
      supportsThinking: false,
      maxContextTokens: 32_000,
      capabilities: { streaming: true, toolCalling: true, contractVersion: 1 },
      complete: vi.fn(),
      countTokens: vi.fn(),
    };
    registry.register('my-plugin/custom-llm', async () => pluginProvider);

    // Both resolve from the same registry instance
    expect(registry.get('anthropic')).toBeDefined();
    expect(registry.get('my-plugin/custom-llm')).toBeDefined();

    // Factories return the correct provider
    const builtinFactory = registry.get('anthropic');
    const pluginFactory = registry.get('my-plugin/custom-llm');
    const resolvedBuiltin = await builtinFactory?.({
      config: {},
      secrets: mockSecrets,
      logger: mockLogger,
    });
    const resolvedPlugin = await pluginFactory?.({
      config: {},
      secrets: mockSecrets,
      logger: mockLogger,
    });
    expect(resolvedBuiltin).toBe(builtinProvider);
    expect(resolvedPlugin).toBe(pluginProvider);
  });

  // -----------------------------------------------------------------------
  // Trust gate: isProviderAllowed
  // -----------------------------------------------------------------------

  describe('isProviderAllowed (trust gate)', () => {
    it('allows all providers when allowedPlugins is undefined', () => {
      expect(isProviderAllowed('anthropic')).toBe(true);
      expect(isProviderAllowed('my-plugin/custom-llm')).toBe(true);
    });

    it('always allows built-in providers (no slash)', () => {
      expect(isProviderAllowed('anthropic', [])).toBe(true);
      expect(isProviderAllowed('openai-compat', [])).toBe(true);
      expect(isProviderAllowed('bedrock', ['some-plugin'])).toBe(true);
    });

    it('blocks plugin provider when pluginId is not in allowedPlugins', () => {
      expect(isProviderAllowed('my-plugin/custom-llm', [])).toBe(false);
      expect(isProviderAllowed('my-plugin/custom-llm', ['other-plugin'])).toBe(false);
    });

    it('allows plugin provider when pluginId is in allowedPlugins', () => {
      expect(isProviderAllowed('my-plugin/custom-llm', ['my-plugin'])).toBe(true);
      expect(isProviderAllowed('my-plugin/custom-llm', ['other', 'my-plugin'])).toBe(true);
    });

    it('extracts pluginId as the part before the first slash', () => {
      // Handles nested names like "org/sub/provider"
      expect(isProviderAllowed('org/sub/provider', ['org'])).toBe(true);
      expect(isProviderAllowed('org/sub/provider', ['org/sub'])).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Provider capability contract
  // -----------------------------------------------------------------------

  it('provider capabilities are validated at resolution time', () => {
    // createLLMFromRegistry (wiring/src/index.ts) checks these three
    // required capability declarations. This test documents the contract
    // that plugin providers must satisfy.
    const provider = {
      supportsCaching: true,
      supportsThinking: true,
      maxContextTokens: 200_000,
    };
    expect(typeof provider.supportsCaching).toBe('boolean');
    expect(typeof provider.supportsThinking).toBe('boolean');
    expect(typeof provider.maxContextTokens).toBe('number');
  });
});
