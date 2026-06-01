export const skillKeys = {
  all: () => ['skills'] as const,
  list: () => [...skillKeys.all(), 'list'] as const,
  detail: (id: string) => [...skillKeys.all(), 'get', id] as const,
};

export const evolverKeys = {
  all: () => ['evolver'] as const,
  config: () => [...evolverKeys.all(), 'config'] as const,
  pending: () => [...evolverKeys.all(), 'pending'] as const,
  history: () => [...evolverKeys.all(), 'history'] as const,
};
