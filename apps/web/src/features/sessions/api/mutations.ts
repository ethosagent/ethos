import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { rpc } from '../../../rpc';
import { sessionKeys } from './keys';

export function useSessionDelete() {
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (id: string) => rpc.sessions.delete({ id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
    onError: (err) => {
      notification.error({
        message: 'Could not delete session',
        description: err instanceof Error ? err.message : String(err),
        placement: 'topRight',
      });
    },
  });
}

export function useSessionFork() {
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (id: string) => rpc.sessions.fork({ id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
    onError: (err) => {
      notification.error({
        message: 'Could not fork session',
        description: err instanceof Error ? err.message : String(err),
        placement: 'topRight',
      });
    },
  });
}

export function useSessionRename() {
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string | null }) =>
      rpc.sessions.update({ id, title }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
    onError: (err) => {
      notification.error({
        message: 'Could not rename session',
        description: err instanceof Error ? err.message : String(err),
        placement: 'topRight',
      });
    },
  });
}

export function useSessionExport() {
  const { message } = AntApp.useApp();

  return useMutation({
    mutationFn: (id: string) => rpc.sessions.export({ id, format: 'markdown' }),
    onSuccess: (data) => {
      const blob = new Blob([data.content], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = data.filename;
      a.click();
      URL.revokeObjectURL(url);
    },
    onError: () => {
      void message.error('Could not export session');
    },
  });
}

export function useSessionRenameFromChat(currentSessionId: string | undefined | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string | null }) =>
      rpc.sessions.update({ id, title }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionKeys.detail(currentSessionId ?? '') });
      void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}
