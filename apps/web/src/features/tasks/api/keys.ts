export const tasksKeys = {
  all: () => ['tasks'] as const,
  list: (rootSessionKey: string | null) => [...tasksKeys.all(), 'list', rootSessionKey] as const,
  detail: (id: string) => [...tasksKeys.all(), 'detail', id] as const,
};
