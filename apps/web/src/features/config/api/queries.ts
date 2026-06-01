import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { configKeys, onboardingKeys } from './keys';

export function useConfig() {
  return useQuery({
    queryKey: configKeys.all(),
    queryFn: () => rpc.config.get(),
  });
}

export function useConfigRetryFalse() {
  return useQuery({
    queryKey: configKeys.all(),
    queryFn: () => rpc.config.get(),
    retry: false,
  });
}

export function useOnboardingState() {
  return useQuery({
    queryKey: onboardingKeys.state(),
    queryFn: () => rpc.onboarding.state(),
  });
}
