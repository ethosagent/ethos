import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { batchKeys } from './keys';

export function useBatchList() {
  return useQuery({
    queryKey: batchKeys.list(),
    queryFn: () => rpc.batch.list(),
    refetchInterval: 2000,
  });
}
