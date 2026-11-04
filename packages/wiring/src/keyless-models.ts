// ---------------------------------------------------------------------------
// Keyless first-run model pick (plan keyless-first-run §3.3, D8)
//
// One table maps total RAM to ONE existing Ollama catalog id. Context window
// and label are read from MODEL_CATALOG, not repeated here. The table is the
// only place the numbers live. Total RAM, not VRAM (limitation §3.7).
//
// Every id is an `providerId: 'ollama'` row in MODEL_CATALOG: pinned by
// __tests__/keyless-models.test.ts "every tier id is an ollama row in MODEL_CATALOG".
// ---------------------------------------------------------------------------

const GIB = 1024 ** 3;

/** Tier ids, smallest to largest. Usable as `z.enum(KEYLESS_MODEL_IDS)`. */
export const KEYLESS_MODEL_IDS = ['llama3.2', 'qwen3', 'gpt-oss:20b', 'qwen3.8:27b'] as const;

export type KeylessModelId = (typeof KEYLESS_MODEL_IDS)[number];

export interface KeylessModelPick {
  modelId: KeylessModelId;
  /** Display hint only; the UI labels it approximate. */
  approxDownloadGb: number;
  reason: string;
}

interface Tier extends KeylessModelPick {
  /** Exclusive upper bound in bytes. */
  below: number;
}

const TIERS: readonly Tier[] = [
  {
    below: 12 * GIB,
    modelId: 'llama3.2',
    approxDownloadGb: 2.0,
    reason: 'Small 3B model that fits beside an OS and a browser.',
  },
  {
    below: 24 * GIB,
    modelId: 'qwen3',
    approxDownloadGb: 5.2,
    reason: '8B model with tool calling and hybrid reasoning.',
  },
  {
    below: 48 * GIB,
    modelId: 'gpt-oss:20b',
    approxDownloadGb: 13,
    reason: '20B open-weights model with a large context window.',
  },
  {
    below: Number.POSITIVE_INFINITY,
    modelId: 'qwen3.8:27b',
    approxDownloadGb: 17,
    reason: "The catalog's default Ollama model.",
  },
];

export function pickKeylessModel(totalMemBytes: number): KeylessModelPick {
  const fallback = TIERS[0] as Tier;
  const tier = TIERS.find((t) => totalMemBytes < t.below) ?? fallback;
  return { modelId: tier.modelId, approxDownloadGb: tier.approxDownloadGb, reason: tier.reason };
}
