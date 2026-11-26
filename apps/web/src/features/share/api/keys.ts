export const shareKeys = {
  all: () => ['shares'] as const,
  list: () => [...shareKeys.all(), 'list'] as const,
  preview: (sessionId: string, includeToolNames: boolean, pii: boolean) =>
    [...shareKeys.all(), 'preview', sessionId, includeToolNames, pii] as const,
};
