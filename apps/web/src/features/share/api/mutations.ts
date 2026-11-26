import { useMutation, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { shareKeys } from './keys';

type CreateInput = Parameters<typeof rpc.shares.create>[0];

/**
 * `gcTime: 0` drops the result, which holds the full URL (and so the token),
 * from the mutation cache as soon as the dialog that owns it unmounts. The URL
 * is shown once and kept nowhere else.
 */
export function useShareCreate() {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (input: CreateInput) => rpc.shares.create(input),
    onSuccess: (result) => {
      if (result.ok) void queryClient.invalidateQueries({ queryKey: shareKeys.list() });
    },
  });
}

export function useShareRevoke() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => rpc.shares.revoke({ id }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: shareKeys.list() });
    },
  });
}
