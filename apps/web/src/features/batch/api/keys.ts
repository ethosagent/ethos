export const batchKeys = {
  all: () => ['batch'] as const,
  list: () => [...batchKeys.all(), 'list'] as const,
};
