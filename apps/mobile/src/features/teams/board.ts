import type { KanbanEvent, KanbanTask, KanbanTaskStatus } from '@ethosagent/web-contracts';
import { clock, type RowData } from '../../lib/row';

// Board (§6): one column at a time, picked by a chip row carrying counts, in
// the web's column order (`STATUS_COLUMNS`, apps/web/src/components/kanban/
// KanbanBoard.tsx). No drag on a phone — status changes happen in the task.

/** The web's `STATUS_COLUMNS`, verbatim. `archived` and `scheduled` are not columns. */
export const STATUS_COLUMNS: readonly KanbanTaskStatus[] = [
  'todo',
  'ready',
  'running',
  'blocked',
  'needs_revision',
  'failed',
  'done',
];

export const STATUS_LABEL: Record<KanbanTaskStatus, string> = {
  todo: 'todo',
  ready: 'ready',
  running: 'running',
  blocked: 'blocked',
  needs_revision: 'revision',
  failed: 'failed',
  done: 'done',
  archived: 'archived',
  scheduled: 'scheduled',
};

export interface ColumnChip {
  status: KanbanTaskStatus;
  /** `todo · 3`, or `todo · –` while the board is loading (§11a). */
  label: string;
  count: number | null;
}

/** One chip per column; `tasks` null = the board is still loading. */
export function columnChips(tasks: readonly Pick<KanbanTask, 'status'>[] | null): ColumnChip[] {
  return STATUS_COLUMNS.map((status) => {
    const count = tasks ? tasks.filter((t) => t.status === status).length : null;
    return { status, count, label: `${STATUS_LABEL[status]} · ${count ?? '–'}` };
  });
}

/** The column a board opens on: the first that needs the operator
 *  (`needs_revision`, then `blocked`), else the first non-empty, else `todo`. */
export function defaultColumn(tasks: readonly Pick<KanbanTask, 'status'>[]): KanbanTaskStatus {
  for (const s of ['needs_revision', 'blocked'] as const) {
    if (tasks.some((t) => t.status === s)) return s;
  }
  return STATUS_COLUMNS.find((s) => tasks.some((t) => t.status === s)) ?? 'todo';
}

/** A column's tasks, highest priority first, then most recently updated. */
export function columnTasks<T extends Pick<KanbanTask, 'status' | 'priority' | 'updatedAt'>>(
  tasks: readonly T[],
  status: KanbanTaskStatus,
): T[] {
  return tasks
    .filter((t) => t.status === status)
    .sort((a, b) => b.priority - a.priority || b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The reason line per task, from the board's recent events (oldest → newest,
 * last write wins) — the web's `taskReasons` (KanbanBoard.tsx): the verifier's
 * verdict rides on `status_changed → needs_revision` as `data.reason`; a
 * block's reason is the `run_completed {outcome: 'blocked'}` summary.
 */
export function taskReasons(events: readonly KanbanEvent[]): Map<string, string> {
  const reasons = new Map<string, string>();
  for (const e of events) {
    if (e.kind === 'status_changed') {
      const to = e.data.to;
      const reason = e.data.reason;
      if (to === 'needs_revision' && typeof reason === 'string' && reason) {
        reasons.set(e.taskId, reason);
      }
    } else if (e.kind === 'run_completed') {
      const summary = e.data.summary;
      if (e.data.outcome === 'blocked' && typeof summary === 'string' && summary) {
        reasons.set(e.taskId, summary);
      }
    }
  }
  return reasons;
}

/** A tile's trailing mono: `retry 1/3` once a task has been retried, else the assignee. */
export function tileMeta(task: Pick<KanbanTask, 'assignee' | 'retryCount' | 'maxRetries'>): string {
  const who = task.assignee ?? 'unassigned';
  if (task.retryCount > 0) {
    return `${who} · retry ${task.retryCount}/${task.maxRetries ?? '∞'}`;
  }
  return who;
}

/** One `Recent events` row — also the task's audit-trail row. */
export function eventRow(e: KanbanEvent, titles?: ReadonlyMap<string, string>): RowData {
  const subject = titles?.get(e.taskId) ?? `#${e.taskId.slice(0, 8)}`;
  const time = clock(Date.parse(e.createdAt));
  const actor = e.actor;
  switch (e.kind) {
    case 'status_changed': {
      const to = typeof e.data.to === 'string' ? e.data.to : '?';
      const reason =
        typeof e.data.reason === 'string' && e.data.reason ? ` · ${e.data.reason}` : '';
      const glyph = to === 'done' ? '✓' : to === 'needs_revision' || to === 'failed' ? '✗' : '·';
      return {
        glyph: to === 'blocked' ? '⚠' : glyph,
        word: to.replace('_', ' '),
        subject,
        result: `${actor}${reason}`,
        time,
      };
    }
    case 'run_completed': {
      const outcome = typeof e.data.outcome === 'string' ? e.data.outcome : 'ended';
      return {
        glyph: outcome === 'completed' ? '✓' : outcome === 'blocked' ? '⚠' : '·',
        word: outcome,
        subject,
        result: actor,
        time,
      };
    }
    case 'run_started':
      return { glyph: '·', word: 'claimed', subject, result: actor, time };
    case 'commented':
      // The event carries only `commentId`; the text is on `kanban.getTask`.
      return { glyph: '·', word: 'comment', subject, result: actor, time };
    case 'assigned': {
      const to = typeof e.data.assignee === 'string' ? e.data.assignee : actor;
      return { glyph: '·', word: 'assigned', subject, result: to, time };
    }
    default:
      return { glyph: '·', word: e.kind.replace('_', ' '), subject, result: actor, time };
  }
}

/** `Recent events` beneath the column: newest first, heartbeats dropped (noise). */
export function recentEventRows(
  events: readonly KanbanEvent[],
  tasks: readonly Pick<KanbanTask, 'id' | 'title'>[],
  limit = 20,
): RowData[] {
  const titles = new Map(tasks.map((t) => [t.id, t.title]));
  return events
    .filter((e) => e.kind !== 'heartbeat')
    .slice(-limit)
    .reverse()
    .map((e) => eventRow(e, titles));
}
