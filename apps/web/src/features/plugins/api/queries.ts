import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { pluginKeys } from './keys';

export function usePluginsList() {
  return useQuery({
    queryKey: pluginKeys.list(),
    queryFn: () => rpc.plugins.list(),
  });
}

export function usePluginCredentialKeys(pluginId: string | null) {
  return useQuery({
    queryKey: pluginKeys.credentialKeys(pluginId),
    queryFn: () => {
      if (!pluginId) return { keys: [] };
      return rpc.plugins.listCredentialKeys({ pluginId });
    },
    enabled: Boolean(pluginId),
  });
}

export function usePluginPageSpec(pluginId: string | undefined) {
  return useQuery({
    queryKey: pluginKeys.pageSpec(pluginId),
    queryFn: () => rpc.plugins.getPageSpec({ pluginId: pluginId ?? '' }),
    enabled: Boolean(pluginId),
  });
}

export function usePluginToolForPage(
  pluginId: string,
  toolName: string | undefined,
  toolArgs: Record<string, unknown> | undefined,
  autoRefreshMs: number | undefined,
) {
  return useQuery({
    queryKey: pluginKeys.toolForPage(pluginId, toolName, toolArgs),
    queryFn: () =>
      rpc.plugins.invokeToolForPage({ pluginId, toolName: toolName ?? '', args: toolArgs }),
    enabled: Boolean(toolName),
    refetchInterval: autoRefreshMs,
  });
}
