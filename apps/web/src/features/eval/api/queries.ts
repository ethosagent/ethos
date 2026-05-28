import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { evalKeys } from './keys';

export function useEvalList() {
  return useQuery({
    queryKey: evalKeys.list(),
    queryFn: () => rpc.eval.list(),
    refetchInterval: 2000,
  });
}
