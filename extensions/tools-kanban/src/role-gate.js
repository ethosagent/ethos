const COORDINATOR_ONLY = new Set([
    'kanban_create_goal',
    'kanban_create',
    'kanban_assign',
    'kanban_link',
    'kanban_archive',
]);
const COORDINATOR_OR_ASSIGNEE = new Set(['kanban_update_status']);
const ASSIGNEE_ONLY = new Set([
    'kanban_complete',
    'kanban_block',
    'kanban_unblock',
    'kanban_heartbeat',
]);
const KANBAN_PREFIX = 'kanban_';
export function createKanbanRoleGateHook(opts) {
    const { role, personalityId, store } = opts;
    return async (payload) => {
        const { toolName, args } = payload;
        // Non-kanban tools: this hook has no opinion.
        if (!toolName.startsWith(KANBAN_PREFIX))
            return {};
        if (COORDINATOR_ONLY.has(toolName) && role !== 'coordinator') {
            return {
                error: `kanban-role-gate: ${toolName} requires role=coordinator (caller role=${role}). Ask the coordinator to do this.`,
            };
        }
        // Coordinator drives orchestration status changes; otherwise fall through
        // to the assignee check below.
        if (COORDINATOR_OR_ASSIGNEE.has(toolName) && role === 'coordinator')
            return {};
        if (ASSIGNEE_ONLY.has(toolName) || COORDINATOR_OR_ASSIGNEE.has(toolName)) {
            const taskId = extractTaskId(args);
            if (typeof taskId !== 'string') {
                // The tool will reject this in its own arg validation; let it through.
                return {};
            }
            const task = store.getTask(taskId);
            if (!task) {
                // Unknown task — let the tool surface the not-found error.
                return {};
            }
            if (task.assignee !== personalityId) {
                return {
                    error: `kanban-role-gate: ${toolName} on ${taskId} requires you to be the assignee (current assignee=${task.assignee ?? 'unassigned'}, you=${personalityId}).`,
                };
            }
        }
        // Any-member tools: no restriction beyond being in the team.
        return {};
    };
}
function extractTaskId(args) {
    if (typeof args !== 'object' || args === null)
        return undefined;
    const id = args.task_id;
    return typeof id === 'string' ? id : undefined;
}
