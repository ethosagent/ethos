import type { InitiativeDecideInput } from '@ethosagent/web-contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { initiativesKeys } from './keys';

export function useInitiativeDecide() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: InitiativeDecideInput) => rpc.initiatives.decide(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: initiativesKeys.all() }),
  });
}
