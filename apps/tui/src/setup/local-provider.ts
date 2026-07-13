import { getProvider } from '@ethosagent/wiring/provider-catalog';

/** Placeholder API key written for local endpoints, which ignore it. The
 *  openai-compat client rejects an empty `apiKey`, so local providers still
 *  need a non-empty stand-in even though no real key exists. Kept in sync with
 *  the readline-fallback path in apps/ethos. */
export const LOCAL_API_KEY_PLACEHOLDER = 'local';

export interface LocalProviderPlan {
  /** Provider runs against a local OpenAI-compatible endpoint (ollama, vllm). */
  isLocal: boolean;
  /** Skip the API-key entry step — local endpoints ignore it. */
  skipApiKey: boolean;
  /** Preset localhost base URL for the provider, if any. */
  defaultBaseUrl: string | undefined;
  /** Drive the model choice from `GET /v1/models` instead of the static catalog. */
  needsModelFetch: boolean;
}

/** Decide how the setup wizard should branch for a given provider. Pure: reads
 *  only the provider catalog. Local providers (self-hosted auth) skip the
 *  API-key step and fetch their model list from the endpoint. */
export function localProviderPlan(providerId: string | undefined): LocalProviderPlan {
  const entry = providerId ? getProvider(providerId) : undefined;
  const isLocal = entry?.authType === 'self-hosted';
  return {
    isLocal,
    skipApiKey: isLocal,
    defaultBaseUrl: entry?.defaultBaseUrl,
    needsModelFetch: isLocal,
  };
}
