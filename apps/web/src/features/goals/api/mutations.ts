import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { rpc } from '../../../rpc';
import { goalsKeys } from './keys';

function surfaceError(
  notification: ReturnType<typeof AntApp.useApp>['notification'],
  title: string,
  err: unknown,
): void {
  notification.error({
    message: title,
    description: err instanceof Error ? err.message : String(err),
    placement: 'topRight',
  });
}

export function useGoalCancel(id: string) {
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();
  return useMutation({
    mutationFn: () => rpc.goals.cancel({ id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: goalsKeys.all() }),
    onError: (err) => surfaceError(notification, 'Cancel failed', err),
  });
}

export function useGoalResume(id: string) {
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();
  return useMutation({
    mutationFn: () => rpc.goals.resume({ id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: goalsKeys.all() }),
    onError: (err) => surfaceError(notification, 'Resume failed', err),
  });
}

export function useGoalSteer(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (message: string) => rpc.goals.steer({ id, message }),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: goalsKeys.detail(id),
      }),
  });
}
