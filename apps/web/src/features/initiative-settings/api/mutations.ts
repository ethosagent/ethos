import { useMutation, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { initiativeSettingsKeys } from './keys';

export function useInitiativeSettingsSave(personalityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof rpc.initiatives.settingsSave>[0]) =>
      rpc.initiatives.settingsSave(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: initiativeSettingsKeys.personality(personalityId) });
    },
  });
}

export function useConstitutionInitiativesSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof rpc.constitution.initiativesSave>[0]) =>
      rpc.constitution.initiativesSave(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: initiativeSettingsKeys.constitution() });
      // The tab's read-only ceiling line comes from the constitution.
      qc.invalidateQueries({ queryKey: ['initiatives', 'settings'] });
    },
  });
}
