import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { useConnection } from '../state/connection';
import { signalOpener, streams } from './client';
import { useRpc } from './queries';

// The team altitude's reads, keyed like the web's (`['kanban','board',team]`,
// `['teams','ledger',team]`) so one invalidation reaches every screen.

export const teamKeys = {
  detail: (team: string) => ['teams', 'get', team] as const,
  ledger: (team: string) => ['teams', 'ledger', team] as const,
  board: (team: string) => ['kanban', 'board', team] as const,
  task: (team: string, taskId: string) => ['kanban', 'task', team, taskId] as const,
  memory: (team: string) => ['teams', 'memory', team] as const,
};

export function useTeamDetail(team: string) {
  const rpc = useRpc();
  return useQuery({ queryKey: teamKeys.detail(team), queryFn: () => rpc.teams.get({ team }) });
}

export function useBoard(team: string) {
  const rpc = useRpc();
  return useQuery({
    queryKey: teamKeys.board(team),
    queryFn: () => rpc.kanban.getBoard({ team }),
  });
}

export function useLedger(team: string, limit: number) {
  const rpc = useRpc();
  return useQuery({
    queryKey: [...teamKeys.ledger(team), limit],
    queryFn: () => rpc.teams.ledger({ team, limit }),
  });
}

// A burst of frames (the cold-connect tail, several live writes) collapses to
// one refetch — the web's `useKanbanBoardSync` window.
const INVALIDATE_DEBOUNCE_MS = 200;

// Every team screen holds the feed while focused. Pushing Overview → Task can
// run the new screen's focus before the old one's blur, and both name the
// same path, so the feed closes only when its last holder lets go.
const holders = new Map<string, number>();

/**
 * `/sse/kanban/:team` while a team screen is focused, in the feed slot of the
 * two-stream budget (R6a) — so it replaces `/sse/activity`, never the session
 * stream. Every frame invalidates the board, the open task and the ledger.
 * Returns whether a frame has arrived (the Board's `Recent events · not live`).
 */
export function useKanbanSync(team: string): boolean {
  const queryClient = useQueryClient();
  const [live, setLive] = useState(false);
  useFocusEffect(
    useCallback(() => {
      const { url, key } = useConnection.getState();
      if (!url || !key) return;
      const path = `/sse/kanban/${encodeURIComponent(team)}`;
      let timer: ReturnType<typeof setTimeout> | null = null;
      streams.openFeed(
        path,
        signalOpener(url, key, () => {
          setLive(true);
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            void queryClient.invalidateQueries({ queryKey: teamKeys.board(team) });
            void queryClient.invalidateQueries({ queryKey: ['kanban', 'task', team] });
            void queryClient.invalidateQueries({ queryKey: teamKeys.ledger(team) });
          }, INVALIDATE_DEBOUNCE_MS);
        }),
      );
      holders.set(path, (holders.get(path) ?? 0) + 1);
      return () => {
        if (timer) clearTimeout(timer);
        const left = (holders.get(path) ?? 1) - 1;
        if (left > 0) holders.set(path, left);
        else {
          holders.delete(path);
          streams.closeFeed(path);
        }
        setLive(false);
      };
    }, [team, queryClient]),
  );
  return live;
}
