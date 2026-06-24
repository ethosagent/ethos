import { validateUrl } from '@ethosagent/core';
import { anthropicFactory } from '@ethosagent/llm-anthropic';
import { azureFactory } from '@ethosagent/llm-azure';
import { codexFactory } from '@ethosagent/llm-codex';
import { OPENAI_COMPAT_ALIASES, openaiCompatFactory } from '@ethosagent/llm-openai-compat';
import type {
  ConfigOnlyProviderManifest,
  LLMProviderFactory,
  LLMProviderRegistry,
} from '@ethosagent/types';
import { createConfigOnlyFactory } from './config-only-provider';
import { BUILTIN_CONFIG_PROVIDERS } from './provider-manifests';

// Re-export so existing importers (if any) still find it at this path.
export { AZURE_DEFAULT_API_VERSION } from '@ethosagent/llm-azure';

/**
 * Register ALL built-in LLM providers on the given registry.
 *
 * Used by the standalone `createLLM` helper (no plugin infrastructure).
 * The `buildInfrastructure` path uses `activateFirstPartyPlugins` +
 * `registerRemainingBuiltinProviders` instead.
 */
export function registerBuiltinProviders(registry: LLMProviderRegistry): void {
  // --- Migrated providers (factories imported from extensions) ---------------
  registry.register('anthropic', anthropicFactory);

  // Azure: wrap with SSRF gate
  const validatedAzure: LLMProviderFactory = async (ctx) => {
    if (ctx.config.baseUrl) {
      validateUrl(ctx.config.baseUrl as string, { allowLocalhost: true });
    }
    return azureFactory(ctx);
  };
  registry.register('azure', validatedAzure);

  registry.register('codex', codexFactory);

  // OpenAI-compat: wrap with SSRF gate
  const validatedOpenaiCompat: LLMProviderFactory = async (ctx) => {
    if (ctx.config.baseUrl) {
      validateUrl(ctx.config.baseUrl as string, { allowLocalhost: true });
    }
    return openaiCompatFactory(ctx);
  };
  registry.register('openai-compat', validatedOpenaiCompat);
  for (const id of OPENAI_COMPAT_ALIASES) {
    registry.register(id, validatedOpenaiCompat);
  }

  // --- Not-yet-migrated providers -------------------------------------------
  registerDynamicProviders(registry);

  // Config-only providers from built-in manifests
  for (const manifest of BUILTIN_CONFIG_PROVIDERS) {
    registerConfigOnlyProvider(registry, manifest);
  }
}

/**
 * Register built-in providers NOT yet migrated to the plugin SDK.
 * Called by `buildInfrastructure` after `activateFirstPartyPlugins` handles
 * the four migrated providers (anthropic, openai-compat, azure, codex).
 */
export function registerRemainingBuiltinProviders(registry: LLMProviderRegistry): void {
  registerDynamicProviders(registry);

  for (const manifest of BUILTIN_CONFIG_PROVIDERS) {
    registerConfigOnlyProvider(registry, manifest);
  }
}

/**
 * Bedrock + gemini-native — dynamically imported, not yet migrated to plugin SDK.
 */
function registerDynamicProviders(registry: LLMProviderRegistry): void {
  registry.register('bedrock', async ({ config: cfg, secrets }) => {
    const { BedrockProvider } = await import('@ethosagent/llm-bedrock');
    const region = (cfg.region as string) ?? 'us-east-1';
    const accessKeyId =
      (await secrets.get('providers/bedrock/accessKeyId')) ?? (cfg.accessKeyId as string);
    const secretAccessKey =
      (await secrets.get('providers/bedrock/secretAccessKey')) ?? (cfg.secretAccessKey as string);
    const sessionToken =
      (await secrets.get('providers/bedrock/sessionToken')) ??
      (cfg.sessionToken as string | undefined);
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('Bedrock provider requires accessKeyId and secretAccessKey credentials');
    }
    return new BedrockProvider({
      region,
      modelId: cfg.model as string,
      sigv4: { region, accessKeyId, secretAccessKey, sessionToken },
    });
  });

  registry.register('gemini-native', async ({ config: cfg, secrets }) => {
    const { GeminiNativeProvider } = await import('@ethosagent/llm-gemini-native');
    const apiKey = (await secrets.get('providers/gemini-native/apiKey')) ?? (cfg.apiKey as string);
    if (!apiKey) {
      throw new Error('Gemini native provider requires an API key');
    }
    return new GeminiNativeProvider({
      apiKey,
      model: cfg.model as string,
      baseUrl: cfg.baseUrl as string | undefined,
    });
  });
}

export function registerConfigOnlyProvider(
  registry: LLMProviderRegistry,
  manifest: ConfigOnlyProviderManifest,
): void {
  registry.register(manifest.id, createConfigOnlyFactory(manifest));
}
