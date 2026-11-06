import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { rpc } from '../../../rpc';
import { useCatalog } from '../../catalog/api/queries';
import { presetsFromCatalog } from '../catalog';
import { mcpKeys } from './keys';

export function useMcpList(enabled?: boolean) {
  return useQuery({
    queryKey: mcpKeys.list(),
    queryFn: () => rpc.mcp.list(),
    enabled,
  });
}

/**
 * The MCP presets (remote and local) for the Add-MCP modal and the onboarding
 * Connectors step: `catalog.list({ kind: 'mcp' })` through `presetsFromCatalog`.
 * Temporary with it — see `presetsFromCatalog`.
 */
export function useMcpPresets(enabled?: boolean) {
  const catalog = useCatalog('mcp', enabled);
  const presets = useMemo(() => presetsFromCatalog(catalog.data?.entries ?? []), [catalog.data]);
  return { ...presets, isLoading: catalog.isLoading, isError: catalog.isError };
}

export function useMcpPersonalityServers(personalityId: string) {
  return useQuery({
    queryKey: mcpKeys.personalityServers(personalityId),
    queryFn: () => rpc.mcp.personalityServers({ personalityId }),
  });
}
