import { validateUrl } from '@ethosagent/core';
import { checkPluginContractMajor, PLUGIN_CONTRACT_MAJOR } from '@ethosagent/plugin-contract';
import type { EthosPluginApi } from '@ethosagent/plugin-sdk';
import type { LLMProviderFactory, LLMProviderRegistry, Logger } from '@ethosagent/types';

export interface FirstPartyPlugin {
  /** Stable plugin identifier (e.g. `@ethosagent/llm-anthropic`). */
  id: string;
  /** The plugin module — must export `activate(api)`. */
  activate: (api: EthosPluginApi) => void | Promise<void>;
  /** Contract major declared by the plugin. Checked against the current
   *  `PLUGIN_CONTRACT_MAJOR` — a mismatch fails the activation. */
  contractMajor: number;
}

/**
 * Activate first-party (built-in) LLM provider plugins.
 *
 * Trusted tier: skips disk discovery and the untrusted-code safety scan.
 * Still honors the `pluginContractMajor` compatibility gate so a contract
 * bump that breaks built-ins surfaces in CI.
 *
 * Registers under bare names (not namespaced) because built-in providers
 * are referenced in config.yaml as `provider: <name>`.
 */
export async function activateFirstPartyPlugins(
  plugins: FirstPartyPlugin[],
  llmProviders: LLMProviderRegistry,
  log: Logger,
): Promise<void> {
  for (const plugin of plugins) {
    const compat = checkPluginContractMajor(plugin.contractMajor, PLUGIN_CONTRACT_MAJOR, plugin.id);
    if (!compat.ok) {
      throw new Error(compat.reason);
    }

    const api: EthosPluginApi = createFirstPartyApi(plugin.id, llmProviders);
    await plugin.activate(api);
    log.info(`[first-party] activated ${plugin.id}`);
  }
}

function createFirstPartyApi(pluginId: string, llmProviders: LLMProviderRegistry): EthosPluginApi {
  const notSupported = (method: string) => () => {
    throw new Error(
      `First-party plugin "${pluginId}" called ${method}(), ` +
        'which is not supported in the first-party activation path.',
    );
  };

  return {
    pluginId,
    registerLLMProvider(name: string, factory: LLMProviderFactory) {
      const validated: LLMProviderFactory = async (ctx) => {
        if (ctx.config.baseUrl) {
          validateUrl(ctx.config.baseUrl as string, { allowLocalhost: true });
        }
        return factory(ctx);
      };
      llmProviders.register(name, validated);
    },
    registerTool: notSupported('registerTool'),
    registerVoidHook: notSupported('registerVoidHook'),
    registerModifyingHook: notSupported('registerModifyingHook'),
    registerInjector: notSupported('registerInjector'),
    registerPersonality: notSupported('registerPersonality'),
    registerContextEngine: notSupported('registerContextEngine'),
    registerMemoryProvider: notSupported('registerMemoryProvider'),
    registerStorage: notSupported('registerStorage'),
    registerExecutionBackend: notSupported('registerExecutionBackend'),
    registerPlatformAdapter: notSupported('registerPlatformAdapter'),
    hasSecret: () => false,
    getSecret: async () => null,
    setSecret: notSupported('setSecret'),
    onCredentialUpdate: notSupported('onCredentialUpdate'),
    registerToolFilter: notSupported('registerToolFilter'),
    registerEvaluator: notSupported('registerEvaluator'),
    registerRoute: notSupported('registerRoute'),
    emit: notSupported('emit'),
    on: notSupported('on'),
    registerOAuth: notSupported('registerOAuth'),
    registerOAuthProfile: notSupported('registerOAuthProfile'),
    registerCustomOAuthFlow: notSupported('registerCustomOAuthFlow'),
    getBaseUrl: () => undefined,
    registerMonitor: notSupported('registerMonitor'),
    startMonitor: notSupported('startMonitor'),
    stopMonitor: notSupported('stopMonitor'),
    notify: notSupported('notify'),
    registerHealthCheck: notSupported('registerHealthCheck'),
    registerPluginPage: notSupported('registerPluginPage'),
    registerRenderer: notSupported('registerRenderer'),
    registerDataSource: notSupported('registerDataSource'),
    registerSlashCommand: notSupported('registerSlashCommand'),
    registerCliSubcommand: notSupported('registerCliSubcommand'),
    registerCommand: notSupported('registerCommand'),
    registerDocumentExtractor: notSupported('registerDocumentExtractor'),
    diagnostics: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      metric: () => {},
    },
  } as EthosPluginApi;
}
