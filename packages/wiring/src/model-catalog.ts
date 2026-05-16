export interface ModelCatalogEntry {
  providerId: string;
  modelId: string;
  label: string;
  contextWindow: number;
  default?: boolean;
}

/** Context window below which a warning is shown in the model picker. */
export const MIN_CONTEXT_WINDOW = 64_000;

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  // Anthropic
  {
    providerId: 'anthropic',
    modelId: 'claude-opus-4-7',
    label: 'most capable',
    contextWindow: 200_000,
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    label: 'fast, balanced',
    contextWindow: 200_000,
    default: true,
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-haiku-4-5-20251001',
    label: 'cheapest, fast',
    contextWindow: 200_000,
  },
  // OpenAI
  {
    providerId: 'openai',
    modelId: 'gpt-4o',
    label: 'most capable',
    contextWindow: 128_000,
    default: true,
  },
  { providerId: 'openai', modelId: 'gpt-4o-mini', label: 'fast, cheap', contextWindow: 128_000 },
  { providerId: 'openai', modelId: 'o1', label: 'reasoning', contextWindow: 200_000 },
  // OpenRouter top picks
  {
    providerId: 'openrouter',
    modelId: 'anthropic/claude-sonnet-4-6',
    label: 'Claude Sonnet',
    contextWindow: 200_000,
    default: true,
  },
  {
    providerId: 'openrouter',
    modelId: 'anthropic/claude-opus-4-7',
    label: 'Claude Opus',
    contextWindow: 200_000,
  },
  {
    providerId: 'openrouter',
    modelId: 'google/gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    contextWindow: 1_000_000,
  },
  {
    providerId: 'openrouter',
    modelId: 'moonshotai/kimi-k2.6',
    label: 'Kimi K2',
    contextWindow: 131_072,
  },
  // Azure AI Foundry — source: https://ai.azure.com/catalog/models
  // The `modelId` is the deployment name in Azure. By convention Azure admins
  // name a deployment after the base model. If yours uses a custom name
  // (e.g. `prod-chat-v2`), pick any entry here and edit `model:` in
  // ~/.ethos/config.yaml. Context windows are nominal; verify per-deployment.
  {
    providerId: 'azure',
    modelId: 'gpt-5.4',
    label: 'frontier, complex work',
    contextWindow: 200_000,
    default: true,
  },
  {
    providerId: 'azure',
    modelId: 'gpt-5.4-pro',
    label: 'most capable frontier',
    contextWindow: 200_000,
  },
  {
    providerId: 'azure',
    modelId: 'gpt-5.4-mini',
    label: 'compact, cost-efficient',
    contextWindow: 128_000,
  },
  {
    providerId: 'azure',
    modelId: 'gpt-5.4-nano',
    label: 'ultra-efficient at scale',
    contextWindow: 128_000,
  },
  {
    providerId: 'azure',
    modelId: 'claude-opus-4-6',
    label: 'Claude Opus on Azure',
    contextWindow: 1_000_000,
  },
  {
    providerId: 'azure',
    modelId: 'claude-sonnet-4-6',
    label: 'Claude Sonnet on Azure',
    contextWindow: 1_000_000,
  },
  {
    providerId: 'azure',
    modelId: 'DeepSeek-V4-Pro',
    label: 'reasoning MoE',
    contextWindow: 1_000_000,
  },
  // Gemini
  {
    providerId: 'gemini',
    modelId: 'gemini-2.5-pro',
    label: 'most capable',
    contextWindow: 1_000_000,
    default: true,
  },
  {
    providerId: 'gemini',
    modelId: 'gemini-2.0-flash',
    label: 'fast, cheap',
    contextWindow: 1_000_000,
  },
  // Groq
  {
    providerId: 'groq',
    modelId: 'llama-3.3-70b-versatile',
    label: 'LLaMA 3.3 70B',
    contextWindow: 32_768,
    default: true,
  },
  {
    providerId: 'groq',
    modelId: 'llama-3.1-8b-instant',
    label: 'fastest, cheapest',
    contextWindow: 131_072,
  },
  // DeepSeek
  {
    providerId: 'deepseek',
    modelId: 'deepseek-chat',
    label: 'best balance',
    contextWindow: 64_000,
    default: true,
  },
  {
    providerId: 'deepseek',
    modelId: 'deepseek-reasoner',
    label: 'reasoning model',
    contextWindow: 64_000,
  },
  // Ollama
  {
    providerId: 'ollama',
    modelId: 'llama3.2',
    label: '3B, fast',
    contextWindow: 8_192,
    default: true,
  },
  { providerId: 'ollama', modelId: 'mistral', label: '7B', contextWindow: 32_768 },
];

export function getModelsForProvider(providerId: string): ModelCatalogEntry[] {
  return MODEL_CATALOG.filter((m) => m.providerId === providerId);
}

export function getDefaultModel(providerId: string): ModelCatalogEntry | undefined {
  const models = getModelsForProvider(providerId);
  return models.find((m) => m.default) ?? models[0];
}

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M ctx`;
  return `${Math.round(tokens / 1_000)}k ctx`;
}
