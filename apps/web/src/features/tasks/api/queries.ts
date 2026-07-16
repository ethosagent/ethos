import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { tasksKeys } from './keys';

// Background jobs are scoped by root session key (the JobStore has no global
// list). The page selects a session; we pass its key. When no session is
// selected the query is disabled and the list stays empty.
export function useTasksList(rootSessionKey: string | null) {
  return useQuery({
    queryKey: tasksKeys.list(rootSessionKey),
    queryFn: () => rpc.tasks.list(rootSessionKey ? { rootSessionKey } : {}),
    enabled: !!rootSessionKey,
    refetchInterval: 3000,
  });
}

export function useTaskDetail(id: string | null) {
  return useQuery({
    queryKey: tasksKeys.detail(id ?? ''),
    queryFn: () => rpc.tasks.get({ id: id ?? '' }),
    enabled: !!id,
    refetchInterval: 3000,
  });
}
