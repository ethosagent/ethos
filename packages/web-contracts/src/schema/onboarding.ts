import { z } from 'zod';

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export const OnboardingStepSchema = z.enum([
  'welcome',
  'provider',
  'personality',
  'integrations',
  'first-turn',
  'done',
]);
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

export const ProviderIdSchema = z.enum([
  'anthropic',
  'openai',
  'openrouter',
  'openai-compat',
  'ollama',
  'azure',
  'codex',
  'xai',
]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ProviderEntrySchema = z.object({
  provider: z.string(),
  model: z.string().nullable(),
  apiKeyPreview: z.string(),
  baseUrl: z.string().nullable(),
});
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;

// ---------------------------------------------------------------------------
// Keyless first run (plan keyless-first-run §7)
// ---------------------------------------------------------------------------

/**
 * The four RAM-tier Ollama ids `onboarding.pullModel` accepts. web-contracts
 * depends on `@ethosagent/types` only, so it cannot import wiring's
 * `KEYLESS_MODEL_IDS`; this literal is a copy. The copy is pinned equal by
 * apps/web-api/src/services/__tests__/onboarding-keyless.test.ts
 * ("pullModel enum equals KEYLESS_MODEL_IDS").
 */
export const KeylessModelIdSchema = z.enum(['llama3.2', 'qwen3', 'gpt-oss:20b', 'qwen3.8:27b']);
export type KeylessModelId = z.infer<typeof KeylessModelIdSchema>;

export const ExternalLoginSourceSchema = z.enum(['codex-cli', 'hermes']);

/**
 * A way to answer a first turn without a pasted key. `external-login` carries
 * no `path` (the server's home directory never reaches the browser) and no
 * candidate carries token material. Pinned by the "path omitted on the wire"
 * and "no token in any response" cases in onboarding-keyless.test.ts.
 */
export const KeylessCandidateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local'),
    runtime: z.enum(['ollama', 'vllm', 'llamacpp', 'lmstudio']),
    provider: z.enum(['ollama', 'vllm', 'openai-compat']),
    baseUrl: z.string(),
    models: z.array(z.string()),
    contextWindow: z.number().int().positive().optional(),
    /** Additive. Known served window under the floor (probe: packages/wiring/src/keyless-probe.ts). */
    belowContextFloor: z
      .object({
        servedTokens: z.number().int().positive(),
        floorTokens: z.number().int().positive(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal('external-login'),
    source: ExternalLoginSourceSchema,
    provider: z.literal('codex'),
  }),
  z.object({ kind: z.literal('ethos-login'), provider: z.literal('codex') }),
  z.object({ kind: z.literal('install-offer') }),
  z.object({ kind: z.literal('paste-key') }),
]);
export type KeylessCandidate = z.infer<typeof KeylessCandidateSchema>;

export const OnboardingProbeOutputSchema = z.object({
  candidates: z.array(KeylessCandidateSchema),
  recommended: z.number().int().nonnegative(),
  machine: z.object({
    totalMemGiB: z.number(),
    pick: z.object({ modelId: KeylessModelIdSchema, approxDownloadGb: z.number() }),
  }),
  /** Command TEXT only. The server never runs it (plan D11). */
  install: z.object({
    os: z.enum(['linux', 'darwin', 'win32', 'other']),
    command: z.string().nullable(),
    notes: z.string(),
    downloadUrl: z.string().nullable(),
  }),
});

export const OnboardingImportCodexLoginInputSchema = z.object({
  source: ExternalLoginSourceSchema,
});
export const OnboardingImportCodexLoginOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), models: z.array(z.string()) }),
  z.object({ ok: z.literal(false), code: z.enum(['absent', 'invalid_shape']) }),
]);

export const OnboardingPullModelInputSchema = z.object({ model: KeylessModelIdSchema });
export const OnboardingPullStatusOutputSchema = z.object({
  state: z.enum(['idle', 'pulling', 'done', 'error']),
  completedBytes: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
  error: z.string().nullable(),
});

export const OnboardingNamePersonalityInputSchema = z.object({
  sourceId: z.string().min(1),
  name: z.string().min(1).max(64),
});
export const OnboardingNamePersonalityOutputSchema = z.object({ personalityId: z.string() });

export const KeylessPathSchema = z.enum([
  'ethos-login',
  'external-login',
  'local',
  'installed',
  'key',
]);
