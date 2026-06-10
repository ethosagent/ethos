import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { goalsKeys } from './keys';

export function useGoalsList() {
  return useQuery({
    queryKey: goalsKeys.list(),
    queryFn: () => rpc.goals.list({}),
  });
}

export function useGoalDetail(id: string) {
  return useQuery({
    queryKey: goalsKeys.detail(id),
    queryFn: () => rpc.goals.get({ id }),
    refetchInterval: 3000,
  });
}
