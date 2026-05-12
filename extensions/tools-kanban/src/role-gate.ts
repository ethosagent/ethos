import type { KanbanStore } from '@ethosagent/kanban-store';
import type { BeforeToolCallPayload, BeforeToolCallResult } from '@ethosagent/types';

/**
 * Role-based authorization for kanban tools — Plan B's policy layer.
 *
 * Three tiers:
 *   - coordinator-only: kanban_create_goal, kanban_create, kanban_assign,
 *     kanban_link, kanban_archive
 *   - assignee-only:    kanban_complete, kanban_block, kanban_unblock,
 *     kanban_heartbeat (only the task's assignee may close their own task)
 *   - any member:       everything else (kanban_comment, kanban_show, kanban_list,
 *     kanban_update_status)
 *
 * Wiring registers this hook with `registerModifying('before_tool_call', ...)`
 * when both a team manifest and a role are active. Solo personalities never
 * see the hook, so Plan A behavior is unchanged.
 *
 * Rejections come back as `{ error }`; AgentLoop translates that into a
 * `tool_result` with `is_error: true` so the LLM contract stays intact.
 */
export type TeamRole = 'coordinator' | 'member';

export interface KanbanRoleGateOptions {
  /** Role of the caller, fixed at boot time per `ethos serve --role`. */
  role: TeamRole;
  /** Personality id of the caller, used for assignee-only checks. */
  personalityId: string;
  /** Shared team board — assignee-only checks read it to compare current assignee. */
  store: KanbanStore;
}

const COORDINATOR_ONLY = new Set([
  'kanban_create_goal',
  'kanban_create',
  'kanban_assign',
  'kanban_link',
  'kanban_archive',
]);

// kanban_update_status is assignee-only: it can drive a task to any status
// including `done`/`blocked`/`archived`, which would otherwise let any member
// bypass the closer-tool checks below. Treating it as any-member made the
// role gate cosmetic for closing work.
const ASSIGNEE_ONLY = new Set([
  'kanban_complete',
  'kanban_block',
  'kanban_unblock',
  'kanban_heartbeat',
  'kanban_update_status',
]);

const KANBAN_PREFIX = 'kanban_';

export function createKanbanRoleGateHook(
  opts: KanbanRoleGateOptions,
): (payload: BeforeToolCallPayload) => Promise<BeforeToolCallResult> {
  const { role, personalityId, store } = opts;

  return async (payload: BeforeToolCallPayload): Promise<BeforeToolCallResult> => {
    const { toolName, args } = payload;

    // Non-kanban tools: this hook has no opinion.
    if (!toolName.startsWith(KANBAN_PREFIX)) return {};

    if (COORDINATOR_ONLY.has(toolName) && role !== 'coordinator') {
      return {
        error: `kanban-role-gate: ${toolName} requires role=coordinator (caller role=${role}). Ask the coordinator to do this.`,
      };
    }

    if (ASSIGNEE_ONLY.has(toolName)) {
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

function extractTaskId(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const id = (args as { task_id?: unknown }).task_id;
  return typeof id === 'string' ? id : undefined;
}
