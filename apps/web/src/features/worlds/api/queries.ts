import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { worldKeys } from './keys';

export function useWorldList() {
  return useQuery({
    queryKey: worldKeys.list(),
    queryFn: () => rpc.worlds.list({}),
    staleTime: 15_000,
  });
}

export function useWorldGraph(
  world: string,
  opts: { asOf: string | null; focus: string | null; hops: number; enabled: boolean },
) {
  return useQuery({
    queryKey: worldKeys.graph(world, opts.asOf, opts.focus, opts.hops),
    queryFn: () =>
      rpc.worlds.graph({
        world,
        ...(opts.asOf ? { asOf: opts.asOf } : {}),
        ...(opts.focus ? { focus: opts.focus, hops: opts.hops } : {}),
      }),
    enabled: opts.enabled,
    placeholderData: keepPreviousData,
  });
}

export function useWorldTree(world: string, enabled: boolean) {
  return useQuery({
    queryKey: worldKeys.tree(world),
    queryFn: () => rpc.worlds.tree({ world }),
    enabled,
  });
}

export function useWorldEntity(world: string, entityId: string | null) {
  return useQuery({
    queryKey: worldKeys.entity(world, entityId ?? ''),
    queryFn: () => rpc.worlds.entity({ world, entityId: entityId ?? '' }),
    enabled: entityId !== null,
  });
}

export function useWorldChanges(world: string, since: string, enabled: boolean) {
  return useQuery({
    queryKey: worldKeys.changes(world, since),
    queryFn: () => rpc.worlds.changes({ world, since }),
    enabled,
  });
}

export function useWorldProposals(world: string, enabled: boolean) {
  return useQuery({
    queryKey: worldKeys.proposals(world),
    queryFn: () => rpc.worlds.proposals({ world, status: 'pending' }),
    enabled,
  });
}

export function useWorldSchema(world: string, enabled: boolean) {
  return useQuery({
    queryKey: worldKeys.schema(world),
    queryFn: () => rpc.worlds.schema({ world }),
    enabled,
  });
}

export function useWorldConfig(world: string, enabled: boolean) {
  return useQuery({
    queryKey: worldKeys.config(world),
    queryFn: () => rpc.worlds.config({ world }),
    enabled,
  });
}
