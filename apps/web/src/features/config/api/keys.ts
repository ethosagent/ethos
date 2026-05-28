export const configKeys = {
  all: () => ['config'] as const,
};

export const onboardingKeys = {
  all: () => ['onboarding'] as const,
  state: () => [...onboardingKeys.all(), 'state'] as const,
};
