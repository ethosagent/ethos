import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { rpc } from '../../../rpc';
import { cronKeys } from './keys';

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

export function useCronRunNow(jobId: string, jobName: string) {
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: () => rpc.cron.runNow({ id: jobId }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: cronKeys.list() });
      notification.success({
        message: `${jobName} ran`,
        description: result.output.slice(0, 200) || '(no output)',
        placement: 'topRight',
      });
    },
    onError: (err) => surfaceError(notification, 'Run failed', err),
  });
}

export function useCronPause(jobId: string) {
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: () => rpc.cron.pause({ id: jobId }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: cronKeys.list() }),
    onError: (err) => surfaceError(notification, 'Pause failed', err),
  });
}

export function useCronResume(jobId: string) {
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: () => rpc.cron.resume({ id: jobId }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: cronKeys.list() }),
    onError: (err) => surfaceError(notification, 'Resume failed', err),
  });
}

export function useCronDelete(jobId: string) {
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: () => rpc.cron.delete({ id: jobId }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: cronKeys.list() }),
    onError: (err) => surfaceError(notification, 'Delete failed', err),
  });
}

interface CreateForm {
  name: string;
  schedule: string;
  prompt: string;
  personalityId: string;
  notifyInApp?: boolean;
}

export function useCronCreate(onClose: () => void) {
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (input: CreateForm) =>
      rpc.cron.create({
        name: input.name,
        schedule: input.schedule,
        prompt: input.prompt,
        personalityId: input.personalityId,
        notifyInApp: input.notifyInApp,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: cronKeys.list() });
      onClose();
    },
    onError: (err) => surfaceError(notification, 'Could not create job', err),
  });
}
