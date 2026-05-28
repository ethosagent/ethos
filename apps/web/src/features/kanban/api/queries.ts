import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { kanbanKeys } from './keys';

export function useKanbanList() {
  return useQuery({
    queryKey: kanbanKeys.list(),
    queryFn: () => rpc.kanban.list(),
    refetchInterval: 5_000,
  });
}

export function useKanbanBoard(team: string) {
  return useQuery({
    queryKey: kanbanKeys.board(team),
    queryFn: () => rpc.kanban.getBoard({ team }),
    enabled: team.length > 0,
    refetchInterval: 2_000,
  });
}
