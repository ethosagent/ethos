import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { initiativesKeys } from './keys';

/** The strip is a glance, not a feed: a window is minutes long. */
const EXPLORING_NOW_POLL_MS = 10_000;

export function useInitiativeList(personalityId: string | undefined) {
  return useQuery({
    queryKey: initiativesKeys.list(personalityId),
    queryFn: () => rpc.initiatives.list(personalityId ? { personalityId } : {}),
  });
}

export function useInitiativeDetail(id: string | null) {
  return useQuery({
    queryKey: initiativesKeys.detail(id ?? ''),
    queryFn: () => rpc.initiatives.get({ id: id ?? '' }),
    enabled: id !== null,
  });
}

export function useInitiativeActivity(id: string | null) {
  return useQuery({
    queryKey: initiativesKeys.activity(id ?? ''),
    queryFn: () => rpc.initiatives.activity({ initiativeId: id ?? '' }),
    enabled: id !== null,
  });
}

export function useExploringNow(personalityId: string | undefined) {
  return useQuery({
    queryKey: initiativesKeys.exploringNow(personalityId),
    queryFn: () => rpc.initiatives.exploringNow(personalityId ? { personalityId } : {}),
    refetchInterval: EXPLORING_NOW_POLL_MS,
  });
}
