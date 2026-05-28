import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { personalityKeys } from './keys';

export function usePersonalityList(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: personalityKeys.list(),
    queryFn: () => rpc.personalities.list({}),
    ...options,
  });
}

export function usePersonalityGet(id: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: personalityKeys.detail(id),
    queryFn: () => rpc.personalities.get({ id }),
    ...options,
  });
}

export function useCharacterSheet(id: string) {
  return useQuery({
    queryKey: personalityKeys.characterSheet(id),
    queryFn: () => rpc.personalities.characterSheet({ id }),
  });
}

export function usePersonalitySkillsList(personalityId: string) {
  return useQuery({
    queryKey: personalityKeys.skills(personalityId),
    queryFn: () => rpc.personalities.skillsList({ personalityId }),
  });
}

export function usePalettePersonalities(enabled: boolean) {
  return useQuery({
    queryKey: personalityKeys.palette(),
    queryFn: () => rpc.personalities.list({}),
    enabled,
  });
}

/** Variant used by PersonalitySwitcher — uses the short key without 'list' */
export function usePersonalitiesShort() {
  return useQuery({
    queryKey: ['personalities'],
    queryFn: () => rpc.personalities.list({}),
  });
}
