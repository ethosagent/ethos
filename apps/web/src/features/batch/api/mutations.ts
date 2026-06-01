import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { rpc } from '../../../rpc';
import { batchKeys } from './keys';

export function useBatchDownload() {
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (id: string) => rpc.batch.output({ id }),
    onSuccess: (result, id) => {
      if (!result.content) {
        notification.info({ message: 'No output yet', placement: 'topRight' });
        return;
      }
      const blob = new Blob([result.content], { type: 'application/jsonl' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `batch-${id}.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
    },
    onError: (err) =>
      notification.error({ message: 'Download failed', description: (err as Error).message }),
  });
}

export function useBatchStart(onClose: () => void) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (values: {
      tasksJsonl: string;
      concurrency: number;
      defaultPersonalityId: string;
    }) =>
      rpc.batch.start({
        tasksJsonl: values.tasksJsonl,
        concurrency: values.concurrency,
        ...(values.defaultPersonalityId
          ? { defaultPersonalityId: values.defaultPersonalityId }
          : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: batchKeys.list() });
      notification.success({ message: 'Batch run started', placement: 'topRight' });
      onClose();
    },
    onError: (err) =>
      notification.error({ message: 'Start failed', description: (err as Error).message }),
  });
}
