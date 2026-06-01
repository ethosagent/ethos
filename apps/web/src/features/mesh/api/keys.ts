export const meshKeys = {
  all: () => ['mesh'] as const,
  list: () => [...meshKeys.all(), 'list'] as const,
};
