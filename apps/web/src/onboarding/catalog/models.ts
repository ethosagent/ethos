import type { CatalogProviderId } from './providers';

export interface ModelCatalogEntry {
  providerId: CatalogProviderId;
  modelId: string;
  label: string;
  contextWindow: number;
  default?: boolean;
}

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  // Anthropic
  {
    providerId: 'anthropic',
    modelId: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    contextWindow: 200_000,
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    contextWindow: 200_000,
    default: true,
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    contextWindow: 200_000,
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-opus-4-5',
    label: 'Claude Opus 4.5',
    contextWindow: 200_000,
  },
  // OpenAI (wires as openai-compat)
  {
    providerId: 'openai',
    modelId: 'gpt-4o',
    label: 'GPT-4o',
    contextWindow: 128_000,
    default: true,
  },
  { providerId: 'openai', modelId: 'gpt-4o-mini', label: 'GPT-4o Mini', contextWindow: 128_000 },
  { providerId: 'openai', modelId: 'gpt-4-turbo', label: 'GPT-4 Turbo', contextWindow: 128_000 },
  { providerId: 'openai', modelId: 'o1', label: 'o1', contextWindow: 200_000 },
  { providerId: 'openai', modelId: 'o3-mini', label: 'o3-mini', contextWindow: 200_000 },
  // OpenRouter
  {
    providerId: 'openrouter',
    modelId: 'anthropic/claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    contextWindow: 200_000,
    default: true,
  },
  { providerId: 'openrouter', modelId: 'openai/gpt-4o', label: 'GPT-4o', contextWindow: 128_000 },
  {
    providerId: 'openrouter',
    modelId: 'meta-llama/llama-3.3-70b-instruct',
    label: 'Llama 3.3 70B',
    contextWindow: 128_000,
  },
  {
    providerId: 'openrouter',
    modelId: 'google/gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    contextWindow: 1_000_000,
  },
  // Ollama (no fixed catalog — users get their local models)
  // Codex
  { providerId: 'codex', modelId: 'gpt-5.4', label: 'GPT-5.4', contextWindow: 0 },
  {
    providerId: 'codex',
    modelId: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    contextWindow: 0,
    default: true,
  },
  { providerId: 'codex', modelId: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', contextWindow: 0 },
  { providerId: 'codex', modelId: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', contextWindow: 0 },
  {
    providerId: 'codex',
    modelId: 'gpt-5.1-codex-max',
    label: 'GPT-5.1 Codex Max',
    contextWindow: 0,
  },
  {
    providerId: 'codex',
    modelId: 'gpt-5.1-codex-mini',
    label: 'GPT-5.1 Codex Mini',
    contextWindow: 0,
  },
];

export function modelsForProvider(providerId: CatalogProviderId): ModelCatalogEntry[] {
  return MODEL_CATALOG.filter((m) => m.providerId === providerId);
}

export function formatContextWindow(n: number): string {
  if (n >= 1_000_000) return `${n / 1_000_000}M ctx`;
  return `${Math.round(n / 1_000)}k ctx`;
}

export const LOW_CONTEXT_THRESHOLD = 64_000;
