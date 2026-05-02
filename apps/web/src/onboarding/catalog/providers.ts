export type CatalogProviderId = 'anthropic' | 'openai' | 'openrouter' | 'openai-compat' | 'ollama';

export interface ProviderCatalogEntry {
  id: CatalogProviderId;
  label: string;
  description: string;
  authType: 'api-key' | 'self-hosted';
  recommended?: boolean;
  signupUrl?: string;
  baseUrl?: {
    default?: string;
    required?: boolean;
    keyless?: boolean;
  };
  /** The ProviderId we wire through to the server */
  wiresAs: 'anthropic' | 'openrouter' | 'openai-compat' | 'ollama';
}

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    description: 'Direct Claude API. Best with the latest Claude models.',
    authType: 'api-key',
    recommended: true,
    signupUrl: 'https://console.anthropic.com',
    wiresAs: 'anthropic',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT-5 / GPT-4 family via api.openai.com.',
    authType: 'api-key',
    recommended: true,
    signupUrl: 'https://platform.openai.com/api-keys',
    baseUrl: { default: 'https://api.openai.com/v1' },
    wiresAs: 'openai-compat',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: '200+ models behind one key.',
    authType: 'api-key',
    recommended: true,
    signupUrl: 'https://openrouter.ai/keys',
    baseUrl: { default: 'https://openrouter.ai/api/v1' },
    wiresAs: 'openrouter',
  },
  {
    id: 'openai-compat',
    label: 'OpenAI-compatible',
    description: 'Any provider that speaks the OpenAI API (Groq, Together, vLLM…).',
    authType: 'api-key',
    baseUrl: { required: true },
    wiresAs: 'openai-compat',
  },
  {
    id: 'ollama',
    label: 'Local Models (Ollama)',
    description: 'No key required — defaults to http://localhost:11434.',
    authType: 'self-hosted',
    baseUrl: { default: 'http://localhost:11434', keyless: true },
    wiresAs: 'ollama',
  },
];

export const API_KEY_PROVIDERS = PROVIDER_CATALOG.filter((p) => p.authType === 'api-key');
export const SELF_HOSTED_PROVIDERS = PROVIDER_CATALOG.filter((p) => p.authType === 'self-hosted');
export const RECOMMENDED_PROVIDERS = PROVIDER_CATALOG.filter((p) => p.recommended);
export const EXPANDED_PROVIDERS = PROVIDER_CATALOG.filter(
  (p) => !p.recommended && p.authType === 'api-key',
);

export function getCatalogEntry(id: CatalogProviderId): ProviderCatalogEntry {
  const found = PROVIDER_CATALOG.find((p) => p.id === id);
  if (found) return found;
  return (
    PROVIDER_CATALOG[0] ?? {
      id: 'anthropic',
      label: 'Anthropic Claude',
      description: '',
      authType: 'api-key',
      wiresAs: 'anthropic',
    }
  );
}
