import { validateUrl } from '@ethosagent/core';
import { OpenAICompatProvider } from '@ethosagent/llm-openai-compat';
import type {
  ConfigOnlyProviderManifest,
  LLMProviderFactory,
  LLMProviderFactoryContext,
} from '@ethosagent/types';

export function createConfigOnlyFactory(manifest: ConfigOnlyProviderManifest): LLMProviderFactory {
  return async (ctx: LLMProviderFactoryContext) => {
    validateUrl(manifest.baseUrl, { allowLocalhost: true });

    const apiKey =
      (await ctx.secrets.get(manifest.auth.secretRef)) ?? (ctx.config.apiKey as string);

    if (!apiKey) {
      throw new Error(
        `Config-only provider "${manifest.id}" requires an API key. ` +
          `Set it via secret ref "${manifest.auth.secretRef}" or config.apiKey.`,
      );
    }

    const model = (ctx.config.model as string) ?? manifest.defaultModel;
    if (!model) {
      throw new Error(
        `Config-only provider "${manifest.id}" requires a model. ` +
          `Set it via config.model or manifest.defaultModel.`,
      );
    }

    const provider = new OpenAICompatProvider({
      name: manifest.id,
      model,
      apiKey,
      baseUrl: manifest.baseUrl,
    });

    // Attach capabilities from manifest
    Object.defineProperty(provider, 'capabilities', {
      get: () => manifest.capabilities,
      enumerable: true,
    });

    return provider;
  };
}
