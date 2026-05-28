export const apiKeyKeys = {
  all: () => ['apiKeys'] as const,
};

export const toolCatalogKeys = {
  all: () => ['tools'] as const,
  catalog: () => [...toolCatalogKeys.all(), 'catalog'] as const,
};
