export const goalsKeys = {
  all: () => ['goals'] as const,
  list: () => [...goalsKeys.all(), 'list'] as const,
  detail: (id: string) => [...goalsKeys.all(), 'detail', id] as const,
};
