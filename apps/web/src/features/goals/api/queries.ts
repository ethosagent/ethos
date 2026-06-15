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

export function useToolResult(goalId: string, toolCallId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...goalsKeys.detail(goalId), 'toolResult', toolCallId],
    queryFn: () => rpc.goals.toolResult({ goalId, toolCallId }),
    enabled: enabled && goalId.length > 0 && toolCallId.length > 0,
    staleTime: 30_000,
  });
}
