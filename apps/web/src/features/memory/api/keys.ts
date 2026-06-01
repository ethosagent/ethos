export const memoryKeys = {
  all: () => ['memory'] as const,
  list: (personalityId: string | null, userId: string | null) =>
    [...memoryKeys.all(), 'list', personalityId, userId] as const,
  listUsers: () => [...memoryKeys.all(), 'listUsers'] as const,
};
