import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { initiativeSettingsKeys } from './keys';

export function useInitiativeSettings(personalityId: string) {
  return useQuery({
    queryKey: initiativeSettingsKeys.personality(personalityId),
    queryFn: () => rpc.initiatives.settings({ personalityId }),
  });
}

export function useConstitutionInitiatives() {
  return useQuery({
    queryKey: initiativeSettingsKeys.constitution(),
    queryFn: () => rpc.constitution.initiatives(),
    // A non-owner refusal is final, not transient: retrying only delays hiding the section.
    retry: false,
  });
}
