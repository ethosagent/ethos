import { os } from './context';

// Thin RPC shells for the kanban namespace. Reads (`list`, `getBoard`) pass
// straight through; mutations (`updateStatus`, `createTask`, `assign`) thread
// an explicit actor label so the audit trail can distinguish UI edits from
// agent calls. `listAgents` delegates to mesh-backed discovery.

export const kanbanRouter = {
  list: os.kanban.list.handler(({ context }) => context.kanban.list()),

  getBoard: os.kanban.getBoard.handler(({ input, context }) => context.kanban.getBoard(input.team)),

  updateStatus: os.kanban.updateStatus.handler(({ input, context }) =>
    context.kanban.updateStatus({
      team: input.team,
      taskId: input.taskId,
      status: input.status,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      actor: 'human:control-center',
    }),
  ),

  createTask: os.kanban.createTask.handler(({ input, context }) =>
    context.kanban.createTask({
      ...input,
      actor: 'human:control-center',
    }),
  ),

  listAgents: os.kanban.listAgents.handler(({ input, context }) =>
    context.kanban.listAgents({ team: input.team }),
  ),

  assign: os.kanban.assign.handler(({ input, context }) =>
    context.kanban.assign({
      team: input.team,
      taskId: input.taskId,
      assignee: input.assignee,
      actor: 'human:control-center',
    }),
  ),
};
