export const initiativesKeys = {
  all: () => ['initiatives'] as const,
  list: (personalityId: string | undefined) =>
    [...initiativesKeys.all(), 'list', personalityId ?? null] as const,
  detail: (id: string) => [...initiativesKeys.all(), 'detail', id] as const,
  activity: (id: string) => [...initiativesKeys.all(), 'activity', id] as const,
  exploringNow: (personalityId: string | undefined) =>
    [...initiativesKeys.all(), 'exploringNow', personalityId ?? null] as const,
  metrics: (personalityId: string) => [...initiativesKeys.all(), 'metrics', personalityId] as const,
};
