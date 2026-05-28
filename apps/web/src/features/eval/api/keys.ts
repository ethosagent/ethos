export const evalKeys = {
  all: () => ['eval'] as const,
  list: () => [...evalKeys.all(), 'list'] as const,
};
