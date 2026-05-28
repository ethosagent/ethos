export const cronKeys = {
  all: () => ['cron'] as const,
  list: () => [...cronKeys.all(), 'list'] as const,
  history: (jobId: string) => [...cronKeys.all(), 'history', jobId] as const,
};
