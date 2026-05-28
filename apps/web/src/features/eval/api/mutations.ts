import type { EvalScorer } from '@ethosagent/web-contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { rpc } from '../../../rpc';
import { evalKeys } from './keys';

export function useEvalDownload() {
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (id: string) => rpc.eval.output({ id }),
    onSuccess: (result, id) => {
      if (!result.content) {
        notification.info({ message: 'No output yet', placement: 'topRight' });
        return;
      }
      const blob = new Blob([result.content], { type: 'application/jsonl' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `eval-${id}.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
    },
    onError: (err) =>
      notification.error({ message: 'Download failed', description: (err as Error).message }),
  });
}

export function useEvalStart(onClose: () => void) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (values: {
      tasksJsonl: string;
      expectedJsonl: string;
      scorer: EvalScorer;
      concurrency: number;
    }) =>
      rpc.eval.start({
        tasksJsonl: values.tasksJsonl,
        expectedJsonl: values.expectedJsonl,
        scorer: values.scorer,
        concurrency: values.concurrency,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: evalKeys.list() });
      notification.success({ message: 'Eval run started', placement: 'topRight' });
      onClose();
    },
    onError: (err) =>
      notification.error({ message: 'Start failed', description: (err as Error).message }),
  });
}
