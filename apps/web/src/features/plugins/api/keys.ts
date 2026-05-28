export const pluginKeys = {
  all: () => ['plugins'] as const,
  list: () => [...pluginKeys.all(), 'list'] as const,
  credentialKeys: (pluginId: string | null) =>
    [...pluginKeys.all(), 'credentialKeys', pluginId] as const,
  pageSpec: (pluginId: string | undefined) => [...pluginKeys.all(), 'pageSpec', pluginId] as const,
  toolForPage: (
    pluginId: string,
    toolName: string | undefined,
    toolArgs: Record<string, unknown> | undefined,
  ) => [...pluginKeys.all(), 'toolForPage', pluginId, toolName, toolArgs] as const,
};
