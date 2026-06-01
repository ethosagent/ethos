import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { cronKeys } from './keys';

export function useCronList() {
  return useQuery({
    queryKey: cronKeys.list(),
    queryFn: () => rpc.cron.list(),
  });
}

export function useCronHistory(jobId: string) {
  return useQuery({
    queryKey: cronKeys.history(jobId),
    queryFn: () => rpc.cron.history({ id: jobId, limit: 5 }),
  });
}
