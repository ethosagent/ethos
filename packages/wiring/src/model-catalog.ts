import type { ModelProfile } from '@ethosagent/types';

export type { ModelProfile, ModelSampling } from '@ethosagent/types';

export interface ModelCatalogEntry {
  providerId: string;
  modelId: string;
  label: string;
  contextWindow: number;
  default?: boolean;
  /** §7 keystone — optional per-model profile (sampling defaults, tool-call
   *  format, output-token cap). Absent for models without a profile, in which
   *  case no defaults are applied and behavior is byte-identical to today. */
  profile?: ModelProfile;
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
    modelId: 'gpt-5.4',
    label: 'frontier, complex work',
    contextWindow: 200_000,
    default: true,
  },
  {
    providerId: 'openai',
    modelId: 'gpt-5.4-pro',
    label: 'most capable frontier',
    contextWindow: 200_000,
  },
  {
    providerId: 'openai',
    modelId: 'gpt-5.4-mini',
    label: 'compact, cost-efficient',
    contextWindow: 200_000,
  },
  {
    providerId: 'openai',
    modelId: 'gpt-5.4-nano',
    label: 'ultra-efficient at scale',
    contextWindow: 200_000,
  },
  { providerId: 'openai', modelId: 'o3', label: 'reasoning', contextWindow: 200_000 },
  {
    providerId: 'openai',
    modelId: 'o3-pro',
    label: 'reasoning, most capable',
    contextWindow: 200_000,
  },
  { providerId: 'openai', modelId: 'o3-mini', label: 'reasoning, fast', contextWindow: 200_000 },
  { providerId: 'openai', modelId: 'o1', label: 'reasoning, prior gen', contextWindow: 200_000 },
  {
    providerId: 'openai',
    modelId: 'o1-mini',
    label: 'reasoning, prior gen mini',
    contextWindow: 200_000,
  },
  {
    providerId: 'openai',
    modelId: 'o1-preview',
    label: 'reasoning, preview',
    contextWindow: 200_000,
  },
  {
    providerId: 'openai',
    modelId: 'gpt-4o',
    label: 'GPT-4o',
    contextWindow: 128_000,
  },
  { providerId: 'openai', modelId: 'gpt-4o-mini', label: 'fast, cheap', contextWindow: 128_000 },
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
  {
    providerId: 'groq',
    modelId: 'deepseek-r1-distill-llama-70b',
    label: 'reasoning, distilled',
    contextWindow: 128_000,
  },
  {
    providerId: 'groq',
    modelId: 'mixtral-8x7b-32768',
    label: 'Mixtral 8x7B MoE',
    contextWindow: 32_768,
  },
  { providerId: 'groq', modelId: 'gemma2-9b-it', label: 'Gemma 2 9B', contextWindow: 8_192 },
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
  // Mistral — direct API. baseUrl: https://api.mistral.ai/v1
  // Set `baseUrl` in ~/.ethos/config.yaml; OpenAICompatProvider handles the
  // rest. Context windows are nominal — verify against the official pricing
  // page if a deployment behaves smaller than expected.
  {
    providerId: 'mistral',
    modelId: 'mistral-large-latest',
    label: 'most capable',
    contextWindow: 128_000,
    default: true,
  },
  {
    providerId: 'mistral',
    modelId: 'mistral-medium-latest',
    label: 'fast, balanced',
    contextWindow: 128_000,
  },
  {
    providerId: 'mistral',
    modelId: 'mistral-small-latest',
    label: 'cheapest, fast',
    contextWindow: 32_000,
  },
  {
    providerId: 'mistral',
    modelId: 'codestral-latest',
    label: 'code-specialized',
    contextWindow: 32_000,
  },
  {
    providerId: 'mistral',
    modelId: 'pixtral-large-latest',
    label: 'vision',
    contextWindow: 128_000,
  },
  {
    providerId: 'mistral',
    modelId: 'ministral-8b-latest',
    label: 'compact',
    contextWindow: 128_000,
  },
  // Together AI — direct API. baseUrl: https://api.together.xyz/v1
  // Model IDs are namespaced (`vendor/model-name`) and required verbatim.
  {
    providerId: 'together',
    modelId: 'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo',
    label: 'Llama 3.1 405B Turbo',
    contextWindow: 130_000,
    default: true,
  },
  {
    providerId: 'together',
    modelId: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
    label: 'Llama 3.1 70B Turbo',
    contextWindow: 130_000,
  },
  {
    providerId: 'together',
    modelId: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
    label: 'Llama 3.1 8B Turbo',
    contextWindow: 130_000,
  },
  {
    providerId: 'together',
    modelId: 'mistralai/Mixtral-8x22B-Instruct-v0.1',
    label: 'Mixtral 8x22B',
    contextWindow: 65_536,
  },
  {
    providerId: 'together',
    modelId: 'Qwen/Qwen2.5-72B-Instruct-Turbo',
    label: 'Qwen 2.5 72B Turbo',
    contextWindow: 32_768,
  },
  {
    providerId: 'together',
    modelId: 'deepseek-ai/DeepSeek-V3',
    label: 'DeepSeek V3',
    contextWindow: 128_000,
  },
  // Fireworks AI — direct API. baseUrl: https://api.fireworks.ai/inference/v1
  // The `accounts/fireworks/models/` prefix is canonical and required.
  {
    providerId: 'fireworks',
    modelId: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    label: 'Llama 3.3 70B',
    contextWindow: 128_000,
    default: true,
  },
  {
    providerId: 'fireworks',
    modelId: 'accounts/fireworks/models/qwen2p5-72b-instruct',
    label: 'Qwen 2.5 72B',
    contextWindow: 32_768,
  },
  {
    providerId: 'fireworks',
    modelId: 'accounts/fireworks/models/deepseek-v3',
    label: 'DeepSeek V3',
    contextWindow: 128_000,
  },
  {
    providerId: 'fireworks',
    modelId: 'accounts/fireworks/models/firefunction-v2',
    label: 'FireFunction v2',
    contextWindow: 8_192,
  },
  // Codex (OpenAI device auth)
  {
    providerId: 'codex',
    modelId: 'gpt-5.4',
    label: 'frontier, complex work',
    contextWindow: 200_000,
  },
  {
    providerId: 'codex',
    modelId: 'gpt-5.4-mini',
    label: 'compact, cost-efficient',
    contextWindow: 200_000,
    default: true,
  },
  {
    providerId: 'codex',
    modelId: 'gpt-5.3-codex',
    label: 'code-specialized',
    contextWindow: 200_000,
  },
  {
    providerId: 'codex',
    modelId: 'gpt-5.2-codex',
    label: 'code-specialized, prior gen',
    contextWindow: 200_000,
  },
  {
    providerId: 'codex',
    modelId: 'gpt-5.1-codex-max',
    label: 'max context, prior gen',
    contextWindow: 200_000,
  },
  {
    providerId: 'codex',
    modelId: 'gpt-5.1-codex-mini',
    label: 'compact, prior gen',
    contextWindow: 200_000,
  },
];

export function getModelsForProvider(providerId: string): ModelCatalogEntry[] {
  return MODEL_CATALOG.filter((m) => m.providerId === providerId);
}

/**
 * Look up the context window for a `(providerId, modelId)` pair. Returns
 * `undefined` on a miss so callers can fall back to the provider default rather
 * than crash. Shared by the model picker and the provider factories so the
 * lookup lives in exactly one place (M1b).
 */
export function lookupContextWindow(providerId: string, modelId: string): number | undefined {
  return MODEL_CATALOG.find((m) => m.providerId === providerId && m.modelId === modelId)
    ?.contextWindow;
}

/**
 * Look up the per-model `profile` for a `(providerId, modelId)` pair. Same
 * lookup shape as {@link lookupContextWindow} (DRY). Returns `undefined` on a
 * miss OR when the entry carries no profile — callers then apply no defaults.
 */
export function lookupProfile(providerId: string, modelId: string): ModelProfile | undefined {
  return MODEL_CATALOG.find((m) => m.providerId === providerId && m.modelId === modelId)?.profile;
}

/**
 * Merge a config `models:` override OVER a catalog `profile`. The override wins
 * field-by-field (per-key for sampling). Precedence within §7: config override
 * beats catalog. Returns `undefined` when neither side sets anything.
 */
export function mergeModelProfile(
  base: ModelProfile | undefined,
  override: ModelProfile | undefined,
): ModelProfile | undefined {
  if (!base && !override) return undefined;
  const merged: ModelProfile = {};
  const sampling = { ...base?.sampling, ...override?.sampling };
  if (Object.keys(sampling).length > 0) merged.sampling = sampling;
  const toolCallFormat = override?.toolCallFormat ?? base?.toolCallFormat;
  if (toolCallFormat !== undefined) merged.toolCallFormat = toolCallFormat;
  const maxOutputTokens = override?.maxOutputTokens ?? base?.maxOutputTokens;
  if (maxOutputTokens !== undefined) merged.maxOutputTokens = maxOutputTokens;
  const structuredOutput = override?.structuredOutput ?? base?.structuredOutput;
  if (structuredOutput !== undefined) merged.structuredOutput = structuredOutput;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function getDefaultModel(providerId: string): ModelCatalogEntry | undefined {
  const models = getModelsForProvider(providerId);
  return models.find((m) => m.default) ?? models[0];
}

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M ctx`;
  return `${Math.round(tokens / 1_000)}k ctx`;
}
