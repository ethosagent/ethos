import { describe, expect, it } from 'vitest';

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
    const { DefaultLLMProviderRegistry } = await import('@ethosagent/core');
    const { registerBuiltinProviders, registerRemainingBuiltinProviders } = await import(
      '../register-builtin-providers'
    );
    const { activateFirstPartyPlugins } = await import('../activate-first-party');
    const { activate: activateAnthropic, PROVIDER_CONTRACT_MAJOR: ac } = await import(
      '@ethosagent/llm-anthropic'
    );
    const { activate: activateOpenaiCompat, PROVIDER_CONTRACT_MAJOR: oc } = await import(
      '@ethosagent/llm-openai-compat'
    );
    const { activate: activateAzure, PROVIDER_CONTRACT_MAJOR: azc } = await import(
      '@ethosagent/llm-azure'
    );
    const { activate: activateCodex, PROVIDER_CONTRACT_MAJOR: cc } = await import(
      '@ethosagent/llm-codex'
    );

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
      ],
      pluginRegistry,
      noopLog,
    );
    registerRemainingBuiltinProviders(pluginRegistry);

    const pluginNames = new Set(pluginRegistry.list());

    expect(pluginNames).toEqual(directNames);
  });

  it('rejects mismatched pluginContractMajor', async () => {
    const { DefaultLLMProviderRegistry } = await import('@ethosagent/core');
    const { activateFirstPartyPlugins } = await import('../activate-first-party');

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
    const { DefaultLLMProviderRegistry } = await import('@ethosagent/core');
    const { activateFirstPartyPlugins } = await import('../activate-first-party');
    const { activate: activateAnthropic, PROVIDER_CONTRACT_MAJOR: ac } = await import(
      '@ethosagent/llm-anthropic'
    );

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
    const { DefaultLLMProviderRegistry } = await import('@ethosagent/core');
    const { activateFirstPartyPlugins } = await import('../activate-first-party');
    const { activate: activateAnthropic, PROVIDER_CONTRACT_MAJOR: ac } = await import(
      '@ethosagent/llm-anthropic'
    );

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
