import type { ApiKeyScope } from '@ethosagent/web-contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { rpc } from '../../../rpc';
import { configKeys } from '../../config/api/keys';
import { apiKeyKeys } from './keys';

export function useConfigUpdate() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (patch: Parameters<typeof rpc.config.update>[0]) => rpc.config.update(patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: configKeys.all() });
      notification.success({ message: 'Settings saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });
}

export function useApiKeyCreate() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (input: { name: string; scopes: ApiKeyScope[]; allowedOrigins: string[] }) =>
      rpc.apiKeys.create(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: apiKeyKeys.all() });
    },
    onError: (err) =>
      notification.error({
        message: 'Failed to create API key',
        description: (err as Error).message,
      }),
  });
}

export function useApiKeyRevoke() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (id: string) => rpc.apiKeys.revoke({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: apiKeyKeys.all() });
      notification.success({ message: 'API key revoked', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({
        message: 'Failed to revoke API key',
        description: (err as Error).message,
      }),
  });
}
