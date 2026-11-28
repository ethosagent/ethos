import { useMutation, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { worldKeys } from './keys';

type DecideInput = Parameters<typeof rpc.worlds.decide>[0];
type PromoteInput = Parameters<typeof rpc.worlds.promote>[0];
type SchemaSaveInput = Parameters<typeof rpc.worlds.schemaSave>[0];
type ConfigSaveInput = Parameters<typeof rpc.worlds.configSave>[0];

function useInvalidateWorlds() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: worldKeys.all() });
}

export function useWorldDecide() {
  const invalidate = useInvalidateWorlds();
  return useMutation({
    mutationFn: (input: DecideInput) => rpc.worlds.decide(input),
    onSettled: invalidate,
  });
}

export function useWorldPromote() {
  const invalidate = useInvalidateWorlds();
  return useMutation({
    mutationFn: (input: PromoteInput) => rpc.worlds.promote(input),
    onSettled: invalidate,
  });
}

export function useWorldSchemaSave() {
  const invalidate = useInvalidateWorlds();
  return useMutation({
    mutationFn: (input: SchemaSaveInput) => rpc.worlds.schemaSave(input),
    onSettled: invalidate,
  });
}

export function useWorldConfigSave() {
  const invalidate = useInvalidateWorlds();
  return useMutation({
    mutationFn: (input: ConfigSaveInput) => rpc.worlds.configSave(input),
    onSettled: invalidate,
  });
}
