import type { KanbanTaskStatus } from '@ethosagent/web-contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { rpc } from '../../../rpc';
import { kanbanKeys } from './keys';

export function useKanbanUpdateStatus(teamName: string) {
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: ({ taskId, status }: { taskId: string; status: KanbanTaskStatus }) =>
      rpc.kanban.updateStatus({ team: teamName, taskId, status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: kanbanKeys.board(teamName) }),
    onError: (err) =>
      notification.error({
        message: 'Status change failed',
        description: (err as Error).message,
      }),
  });
}
