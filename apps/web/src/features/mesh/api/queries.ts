import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { meshKeys } from './keys';

export function useMeshList() {
  return useQuery({
    queryKey: meshKeys.list(),
    queryFn: () => rpc.mesh.list(),
    refetchInterval: 15_000,
  });
}
