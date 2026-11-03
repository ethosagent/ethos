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
