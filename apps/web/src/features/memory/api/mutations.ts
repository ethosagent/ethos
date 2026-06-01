import type { MemoryStoreId } from '@ethosagent/web-contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { rpc } from '../../../rpc';

export function useMemoryWrite(store: MemoryStoreId, personalityId: string, userId?: string) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (content: string) =>
      rpc.memory.write({ store, content, personalityId, ...(userId ? { userId } : {}) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memory', 'list'] });
      notification.success({ message: 'Saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });
}
