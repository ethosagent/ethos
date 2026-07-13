/**
 * Sampling knobs for a per-model profile (§7). `temperature`/`topP` map to
 * `CompletionOptions` fields; `topK`/`minP` are NOT in the frozen
 * `CompletionOptions` and ride `CompletionOptions.providerOptions` instead.
 */
export interface ModelSampling {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
}

/**
 * Per-model config profile (§7 keystone, minimal). Only fields with a live
 * consumer today: sampling defaults, tool-call transport format, and an
 * output-token cap. Later phases add their own fields (structuredOutput,
 * promptBudget, compaction thresholds, charsPerToken, thinking).
 */
export interface ModelProfile {
  sampling?: ModelSampling;
  toolCallFormat?: 'openai' | 'text-xml';
  maxOutputTokens?: number;
  /** §3 — when true, wiring sets `ProviderCapabilities.structuredOutput` so
   *  internal JSON consumers request grammar-constrained decoding. Absent →
   *  capability stays unset (models without native structured output). */
  structuredOutput?: boolean;
}

export interface ModelEntry {
  id: string;
  label: string;
  contextWindow: number;
  default?: boolean;
  /** Optional per-model profile carried through the remote manifest. Absent on
   *  old manifests — they stay valid. */
  profile?: ModelProfile;
}

export interface ProviderCatalog {
  models: ModelEntry[];
}

export interface ModelCatalogManifest {
  version: number;
  updatedAt: string;
  providers: Record<string, ProviderCatalog>;
}
