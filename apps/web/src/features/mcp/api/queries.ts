import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { mcpKeys } from './keys';

export function useMcpList(enabled?: boolean) {
  return useQuery({
    queryKey: mcpKeys.list(),
    queryFn: () => rpc.mcp.list(),
    enabled,
  });
}

export function useMcpPersonalityServers(personalityId: string) {
  return useQuery({
    queryKey: mcpKeys.personalityServers(personalityId),
    queryFn: () => rpc.mcp.personalityServers({ personalityId }),
  });
}
