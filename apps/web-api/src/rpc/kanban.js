import { os } from './context';
// Thin RPC shells for the kanban namespace. Reads (`list`, `getBoard`) pass
// straight through; the mutation (`updateStatus`) threads an explicit actor
// label so the audit trail can distinguish UI edits from agent calls. Mutating
// authorization is intentionally minimal here — any signed-in operator can
// drive the board. A future pass can layer roles onto web-side calls the same
// way the agent-side role gate does.
export const kanbanRouter = {
    list: os.kanban.list.handler(({ context }) => context.kanban.list()),
    getBoard: os.kanban.getBoard.handler(({ input, context }) => context.kanban.getBoard(input.team)),
    updateStatus: os.kanban.updateStatus.handler(({ input, context }) => context.kanban.updateStatus({
        team: input.team,
        taskId: input.taskId,
        status: input.status,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        // Audit trail tag — distinct from any agent personality id so it never
        // collides with the role gate's assignee check.
        actor: 'human:control-center',
    })),
};
