import { DefaultLLMProviderRegistry } from '@ethosagent/core';
import {
  PROVIDER_CONTRACT_MAJOR as ac,
  activate as activateAnthropic,
} from '@ethosagent/llm-anthropic';
import { activate as activateAzure, PROVIDER_CONTRACT_MAJOR as azc } from '@ethosagent/llm-azure';
import {
  activate as activateBedrock,
  PROVIDER_CONTRACT_MAJOR as bc,
} from '@ethosagent/llm-bedrock';
import { activate as activateCodex, PROVIDER_CONTRACT_MAJOR as cc } from '@ethosagent/llm-codex';
import {
  activate as activateGeminiNative,
  PROVIDER_CONTRACT_MAJOR as gc,
} from '@ethosagent/llm-gemini-native';
import {
  activate as activateOpenaiCompat,
  PROVIDER_CONTRACT_MAJOR as oc,
} from '@ethosagent/llm-openai-compat';
import { activate as activateXai, PROVIDER_CONTRACT_MAJOR as xc } from '@ethosagent/llm-xai';
import { describe, expect, it } from 'vitest';
import { activateFirstPartyPlugins } from '../activate-first-party';
import {
  registerBuiltinProviders,
  registerRemainingBuiltinProviders,
} from '../register-builtin-providers';

// Static imports, not per-test `await import(...)`: the provider packages
// (the AWS SDK behind bedrock among them) are a heavy cold graph, and imported
// inside a case their transform counted against that case's 15s budget, which a
// parallel run can exhaust. Imported here it happens at collection, where no
// timeout applies. Nothing in this file needs a fresh module per case.

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLog,
  // biome-ignore lint/suspicious/noExplicitAny: recursive logger mock
} as any;

describe('first-party plugin activation', () => {
  it('registers the same provider names as registerBuiltinProviders', async () => {
    // Path A: direct registration (standalone createLLM)
    const directRegistry = new DefaultLLMProviderRegistry();
    registerBuiltinProviders(directRegistry);
    const directNames = new Set(directRegistry.list());

    // Path B: first-party plugin activation (buildInfrastructure)
    const pluginRegistry = new DefaultLLMProviderRegistry();
    await activateFirstPartyPlugins(
      [
        {
          id: '@ethosagent/llm-anthropic',
          activate: activateAnthropic,
          contractMajor: ac,
        },
        {
          id: '@ethosagent/llm-openai-compat',
          activate: activateOpenaiCompat,
          contractMajor: oc,
        },
        {
          id: '@ethosagent/llm-azure',
          activate: activateAzure,
          contractMajor: azc,
        },
        {
          id: '@ethosagent/llm-codex',
          activate: activateCodex,
          contractMajor: cc,
        },
        {
          id: '@ethosagent/llm-bedrock',
          activate: activateBedrock,
          contractMajor: bc,
        },
        {
          id: '@ethosagent/llm-gemini-native',
          activate: activateGeminiNative,
          contractMajor: gc,
        },
        {
          id: '@ethosagent/llm-xai',
          activate: activateXai,
          contractMajor: xc,
        },
      ],
      pluginRegistry,
      noopLog,
    );
    registerRemainingBuiltinProviders(pluginRegistry);

    const pluginNames = new Set(pluginRegistry.list());

    expect(pluginNames).toEqual(directNames);
    // xAI is registered exactly once, on both paths. `xai` must NOT also appear
    // in OPENAI_COMPAT_ALIASES or BUILTIN_CONFIG_PROVIDERS: the registry throws
    // on a duplicate id and registerBuiltinProviders iterates both lists onto
    // one registry, so a second entry is a boot crash for every user.
    expect(directRegistry.list().filter((n) => n === 'xai')).toEqual(['xai']);
    expect(pluginRegistry.list().filter((n) => n === 'xai')).toEqual(['xai']);
  });

  it('rejects mismatched pluginContractMajor', async () => {
    const registry = new DefaultLLMProviderRegistry();

    await expect(
      activateFirstPartyPlugins(
        [{ id: 'test-plugin', activate: () => {}, contractMajor: 999 }],
        registry,
        noopLog,
      ),
    ).rejects.toThrow(/pluginContractMajor/);
  });

  it('built-in providers register via activate() under bare names', async () => {
    const registry = new DefaultLLMProviderRegistry();
    await activateFirstPartyPlugins(
      [
        {
          id: '@ethosagent/llm-anthropic',
          activate: activateAnthropic,
          contractMajor: ac,
        },
      ],
      registry,
      noopLog,
    );

    expect(registry.get('anthropic')).toBeDefined();
  });

  it('built-in and community providers coexist in the same registry', async () => {
    const registry = new DefaultLLMProviderRegistry();

    // Built-in via first-party activation
    await activateFirstPartyPlugins(
      [
        {
          id: '@ethosagent/llm-anthropic',
          activate: activateAnthropic,
          contractMajor: ac,
        },
      ],
      registry,
      noopLog,
    );

    // Community plugin (simulated namespaced registration)
    registry.register(
      'community-plugin/test-llm',
      async () =>
        ({
          name: 'community-test',
          model: 'test-model',
          maxContextTokens: 4096,
          supportsCaching: false,
          supportsThinking: false,
          supportsCacheBreakpoints: false,
          supportsTokenCounting: 'estimated',
          complete: async function* () {},
          countTokens: async () => 0,
          // biome-ignore lint/suspicious/noExplicitAny: mock provider
        }) as any,
    );

    // Both accessible via the same registry
    expect(registry.get('anthropic')).toBeDefined();
    expect(registry.get('community-plugin/test-llm')).toBeDefined();
    expect(typeof registry.get('anthropic')).toBe('function');
    expect(typeof registry.get('community-plugin/test-llm')).toBe('function');
  });
});
