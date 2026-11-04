import { os } from './context';

// Onboarding namespace — drives the 5-step setup flow when ~/.ethos/config.yaml
// is missing or incomplete. `validateProvider` makes a live network call to
// the provider's models endpoint so users get instant feedback on a bad key.

export const onboardingRouter = {
  state: os.onboarding.state.handler(({ context }) => context.onboarding.state()),

  validateProvider: os.onboarding.validateProvider.handler(({ input, context }) =>
    context.onboarding.validateProvider({
      provider: input.provider,
      apiKey: input.apiKey,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    }),
  ),

  complete: os.onboarding.complete.handler(async ({ input, context }) => {
    await context.onboarding.complete({
      provider: input.provider,
      model: input.model,
      apiKey: input.apiKey,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      personalityId: input.personalityId,
      ...(input.keylessPath ? { keylessPath: input.keylessPath } : {}),
    });
    return { ok: true as const };
  }),

  // Keyless first run (plan keyless-first-run §7).
  probe: os.onboarding.probe.handler(({ context }) => context.onboarding.probe()),
  importCodexLogin: os.onboarding.importCodexLogin.handler(({ input, context }) =>
    context.onboarding.importCodexLogin(input),
  ),
  pullModel: os.onboarding.pullModel.handler(({ input, context }) =>
    context.onboarding.pullModel(input),
  ),
  pullStatus: os.onboarding.pullStatus.handler(({ context }) => context.onboarding.pullStatus()),
  namePersonality: os.onboarding.namePersonality.handler(({ input, context }) =>
    context.onboarding.namePersonality(input),
  ),
};
