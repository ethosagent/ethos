import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { evolverKeys, skillKeys } from './keys';

export function useSkillsList() {
  return useQuery({
    queryKey: skillKeys.list(),
    queryFn: () => rpc.skills.list({}),
  });
}

export function useSkillGet(id: string) {
  return useQuery({
    queryKey: skillKeys.detail(id),
    queryFn: () => rpc.skills.get({ id }),
  });
}

export function useEvolverConfig() {
  return useQuery({
    queryKey: evolverKeys.config(),
    queryFn: () => rpc.evolver.configGet(),
  });
}

export function useEvolverPending() {
  return useQuery({
    queryKey: evolverKeys.pending(),
    queryFn: () => rpc.evolver.pendingList(),
  });
}

export function useEvolverHistory() {
  return useQuery({
    queryKey: evolverKeys.history(),
    queryFn: () => rpc.evolver.history({ limit: 50 }),
  });
}
