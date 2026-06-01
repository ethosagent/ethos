import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { rpc } from '../../../rpc';
import { pluginKeys } from './keys';

export function usePluginInstall() {
  const { notification } = AntApp.useApp();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (spec: string) => rpc.plugins.install({ packageSpec: spec }),
    onSuccess: () => {
      notification.success({ message: 'Plugin installed' });
      qc.invalidateQueries({ queryKey: pluginKeys.list() });
    },
    onError: (err) => {
      notification.error({
        message: 'Install failed',
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });
}

export function useMcpServerDelete() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (name: string) => rpc.mcp.delete({ name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plugins'] });
      qc.invalidateQueries({ queryKey: ['mcp', 'list'] });
    },
    onError: (err) => {
      notification.error({
        message: 'Delete failed',
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });
}
