import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { rpc } from '../../../rpc';
import { tasksKeys } from './keys';

export function useTaskCancel() {
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();
  return useMutation({
    mutationFn: (id: string) => rpc.tasks.cancel({ id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: tasksKeys.all() }),
    onError: (err) =>
      notification.error({
        message: 'Cancel failed',
        description: err instanceof Error ? err.message : String(err),
        placement: 'topRight',
      }),
  });
}
