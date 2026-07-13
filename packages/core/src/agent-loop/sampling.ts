// §7 — apply resolved per-model sampling defaults to a turn's completion opts.
// Precedence: per-call RunOptions value > profile default. `topK`/`minP` are
// not CompletionOptions fields — they ride the provider-namespaced escape hatch.

export interface ModelSamplingDefaults {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
}

export interface CompletionSamplingOpts {
  temperature?: number;
  topP?: number;
  maxCompletionTokens?: number;
  seed?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
}

/**
 * Merge profile sampling defaults UNDER the per-call values. A per-call value
 * always wins; the default fills in only when the caller left it undefined.
 * `defaults` undefined (no profile) → output is byte-identical to the per-call
 * opts, so models without a profile behave exactly as before.
 */
export function applySamplingDefaults(
  perCall: {
    temperature?: number;
    topP?: number;
    maxCompletionTokens?: number;
    seed?: number;
  },
  defaults: ModelSamplingDefaults | undefined,
): CompletionSamplingOpts {
  const topK = defaults?.topK;
  const minP = defaults?.minP;
  const providerOptions =
    topK !== undefined || minP !== undefined
      ? {
          'openai-compat': {
            ...(topK !== undefined ? { topK } : {}),
            ...(minP !== undefined ? { minP } : {}),
          },
        }
      : undefined;
  return {
    temperature: perCall.temperature ?? defaults?.temperature,
    topP: perCall.topP ?? defaults?.topP,
    maxCompletionTokens: perCall.maxCompletionTokens,
    seed: perCall.seed,
    ...(providerOptions ? { providerOptions } : {}),
  };
}
