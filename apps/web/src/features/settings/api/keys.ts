export const apiKeyKeys = {
  all: () => ['apiKeys'] as const,
};

export const toolCatalogKeys = {
  all: () => ['tools'] as const,
  catalog: () => [...toolCatalogKeys.all(), 'catalog'] as const,
};

// Phase 2 — global named secrets + per-personality tool settings.
export const namedSecretKeys = {
  all: () => ['namedSecrets'] as const,
};

export const toolSettingsKeys = {
  all: () => ['toolSettings'] as const,
  schemas: () => [...toolSettingsKeys.all(), 'schemas'] as const,
  default: () => [...toolSettingsKeys.all(), 'default'] as const,
  forPersonality: (id: string) => [...toolSettingsKeys.all(), 'personality', id] as const,
};
