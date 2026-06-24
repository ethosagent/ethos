import { validateUrl } from '@ethosagent/core';
import { AnthropicProvider } from '@ethosagent/llm-anthropic';
import { AzureOpenAIProvider } from '@ethosagent/llm-azure';
import { CodexProvider, ensureValidToken } from '@ethosagent/llm-codex';
import { OpenAICompatProvider } from '@ethosagent/llm-openai-compat';
import type {
  ConfigOnlyProviderManifest,
  LLMProviderFactoryContext,
  LLMProviderRegistry,
} from '@ethosagent/types';
import { createConfigOnlyFactory } from './config-only-provider';
import { BUILTIN_CONFIG_PROVIDERS } from './provider-manifests';

// Default Azure REST API version. Picked to match the model lineup in model-catalog.ts.
// Older stable api-versions (2024-10-21 and earlier) don't know about the `file` content
// part required for PDF input through Chat Completions. Users override per-deployment via
// `apiVersion` in ~/.ethos/config.yaml.
export const AZURE_DEFAULT_API_VERSION = '2024-12-01-preview';

/**
 * Register the built-in LLM providers (anthropic, azure, codex, openai-compat
 * and all its aliases) on the given registry. Called by both `buildInfrastructure`
 * (full agent-loop wiring) and the standalone `createLLM` helper so every
 * dispatch path shares one set of factories.
 */
export function registerBuiltinProviders(registry: LLMProviderRegistry): void {
  registry.register('anthropic', async ({ config: cfg, secrets }) => {
    const apiKey = (await secrets.get('providers/anthropic/apiKey')) ?? (cfg.apiKey as string);
    return new AnthropicProvider({ apiKey, model: cfg.model as string });
  });
  registry.register('azure', async ({ config: cfg, secrets }) => {
    if (!cfg.baseUrl) {
      throw new Error(
        'Azure provider requires `baseUrl` set to the resource endpoint ' +
          '(e.g. https://my-resource.openai.azure.com).',
      );
    }
    // SSRF gate: validate user-supplied base URLs before handing them to SDK
    // clients. `allowLocalhost` is true because local providers are a
    // legitimate use case.
    validateUrl(cfg.baseUrl as string, { allowLocalhost: true });
    const apiKey = (await secrets.get('providers/azure/apiKey')) ?? (cfg.apiKey as string);
    return new AzureOpenAIProvider({
      name: 'azure',
      model: cfg.model as string,
      apiKey,
      endpoint: cfg.baseUrl as string,
      apiVersion: (cfg.apiVersion as string) ?? AZURE_DEFAULT_API_VERSION,
    });
  });
  registry.register('codex', async ({ config: cfg }) => {
    return new CodexProvider({
      model: cfg.model as string,
      getAccessToken: async () => {
        const creds = await ensureValidToken(globalThis.fetch);
        return creds.accessToken;
      },
    });
  });
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
  const openaiCompatFactory = async ({ config: cfg, secrets }: LLMProviderFactoryContext) => {
    const providerName = (cfg.provider as string) ?? 'openai-compat';
    // SSRF gate
    const baseUrl = (cfg.baseUrl as string) ?? 'https://openrouter.ai/api/v1';
    validateUrl(baseUrl, { allowLocalhost: true });
    const apiKey =
      (await secrets.get(`providers/${providerName}/apiKey`)) ?? (cfg.apiKey as string);
    return new OpenAICompatProvider({
      name: providerName,
      model: cfg.model as string,
      apiKey,
      baseUrl,
    });
  };
  registry.register('openai-compat', openaiCompatFactory);
  for (const id of ['openai', 'openrouter', 'gemini', 'groq', 'deepseek', 'ollama']) {
    registry.register(id, openaiCompatFactory);
  }

  // Config-only providers from built-in manifests
  for (const manifest of BUILTIN_CONFIG_PROVIDERS) {
    registerConfigOnlyProvider(registry, manifest);
  }
}

export function registerConfigOnlyProvider(
  registry: LLMProviderRegistry,
  manifest: ConfigOnlyProviderManifest,
): void {
  registry.register(manifest.id, createConfigOnlyFactory(manifest));
}
