import type { ApiKeyScope } from '@ethosagent/web-contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { rpc } from '../../../rpc';
import { configKeys } from '../../config/api/keys';
import { apiKeyKeys, namedSecretKeys, toolSettingsKeys } from './keys';

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

// Phase 2 — named secrets. Values are written to the vault and never
// round-tripped back; the client only ever sends a value, never receives one.

export function useNamedSecretCreate() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (input: Parameters<typeof rpc.namedSecrets.create>[0]) =>
      rpc.namedSecrets.create(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: namedSecretKeys.all() });
      notification.success({ message: 'Secret saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({
        message: 'Failed to save secret',
        description: (err as Error).message,
      }),
  });
}

export function useNamedSecretDelete() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (input: Parameters<typeof rpc.namedSecrets.delete>[0]) =>
      rpc.namedSecrets.delete(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: namedSecretKeys.all() });
      notification.success({ message: 'Secret deleted', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({
        message: 'Failed to delete secret',
        description: (err as Error).message,
      }),
  });
}

// Phase 2 — per-tool settings. Only a secret NAME is ever persisted.

export function useToolSettingsSetDefault() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (values: Parameters<typeof rpc.toolSettings.setDefault>[0]['values']) =>
      rpc.toolSettings.setDefault({ values }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: toolSettingsKeys.default() });
      notification.success({ message: 'Defaults saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });
}

export function useToolSettingsSetForPersonality(personalityId: string) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (values: Parameters<typeof rpc.toolSettings.setForPersonality>[0]['values']) =>
      rpc.toolSettings.setForPersonality({ personalityId, values }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: toolSettingsKeys.forPersonality(personalityId) });
      notification.success({ message: 'Tool settings saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });
}
