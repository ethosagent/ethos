import type { BackgroundJobEventWire } from '@ethosagent/web-contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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

/**
 * `live: false` turns the poll off. The run card asks for the row's STATIC
 * half — label, budget, detail-grid rows — and takes every changing field from
 * the `run.update` digest instead, so the card stays live off the digest alone
 * (pi-delegation D11). The Tasks page keeps the poll: it has no digest.
 */
export function useTaskDetail(id: string | null, opts?: { live?: boolean }) {
  const live = opts?.live ?? true;
  return useQuery({
    queryKey: tasksKeys.detail(id ?? ''),
    queryFn: () => rpc.tasks.get({ id: id ?? '' }),
    enabled: !!id,
    ...(live ? { refetchInterval: 3000 } : {}),
  });
}

/** Newest rows kept client-side; a runaway transcript must not grow the page without bound. */
const EVENTS_KEEP = 500;

/**
 * Cursor poll of a job's event trail (`tasks.events`). The first read takes the
 * newest page; each later poll asks only for rows after the last `seq` it holds
 * and appends them, so the transcript pane never re-downloads the trail.
 * `live: false` (a finished job) reads once and stops.
 */
export function useTaskEvents(id: string | null, opts: { live: boolean }) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: tasksKeys.events(id ?? ''),
    queryFn: async (): Promise<BackgroundJobEventWire[]> => {
      const key = tasksKeys.events(id ?? '');
      const held = queryClient.getQueryData<BackgroundJobEventWire[]>(key) ?? [];
      const last = held[held.length - 1];
      const fresh = await rpc.tasks.events({
        id: id ?? '',
        ...(last ? { afterSeq: last.seq } : {}),
        limit: 200,
      });
      // Same array back when nothing new arrived: react-query keeps the reference, so no re-render.
      if (fresh.length === 0) return held;
      return [...held, ...fresh].slice(-EVENTS_KEEP);
    },
    enabled: !!id,
    ...(opts.live ? { refetchInterval: 2000 } : {}),
  });
}
