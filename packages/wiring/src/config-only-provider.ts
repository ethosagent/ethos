import { validateUrl } from '@ethosagent/core';
import { OpenAICompatProvider } from '@ethosagent/llm-openai-compat';
import type {
  ConfigOnlyProviderManifest,
  LLMProviderFactory,
  LLMProviderFactoryContext,
} from '@ethosagent/types';
import { lookupContextWindow } from './model-catalog';

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

    // M1b — size the context window from the model catalog so compaction sees
    // the real window (e.g. an 8k local model), not the provider's 128k default.
    // An explicit `config.maxContextTokens` (injected by wiring or set by the
    // user) wins; otherwise fall back to the catalog. A catalog miss leaves it
    // undefined, degrading to the provider default — never a crash.
    const explicitWindow =
      typeof ctx.config.maxContextTokens === 'number' ? ctx.config.maxContextTokens : undefined;
    const contextWindow = explicitWindow ?? lookupContextWindow(manifest.id, model);

    // §7 — provider-facing profile fields threaded by wiring's resolveOne (from
    // the merged catalog + config override). Absent → provider defaults apply.
    const toolCallFormat =
      ctx.config.toolCallFormat === 'openai' || ctx.config.toolCallFormat === 'text-xml'
        ? ctx.config.toolCallFormat
        : undefined;
    const maxOutputTokens =
      typeof ctx.config.maxOutputTokens === 'number' ? ctx.config.maxOutputTokens : undefined;

    const provider = new OpenAICompatProvider({
      name: manifest.id,
      model,
      apiKey,
      baseUrl: manifest.baseUrl,
      ...(contextWindow !== undefined ? { maxContextTokens: contextWindow } : {}),
      ...(toolCallFormat !== undefined ? { toolCallFormat } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    });

    // Attach capabilities from manifest
    Object.defineProperty(provider, 'capabilities', {
      get: () => manifest.capabilities,
      enumerable: true,
    });

    return provider;
  };
}
