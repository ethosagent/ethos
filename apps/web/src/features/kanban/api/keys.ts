export const kanbanKeys = {
  all: () => ['kanban'] as const,
  list: () => [...kanbanKeys.all(), 'list'] as const,
  board: (team: string) => [...kanbanKeys.all(), 'board', team] as const,
};
