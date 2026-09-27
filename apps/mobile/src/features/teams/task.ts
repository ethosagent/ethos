import type {
  KanbanComment,
  KanbanEvent,
  KanbanTask,
  KanbanTaskStatus,
} from '@ethosagent/web-contracts';
import { clock, type RowData } from '../../lib/row';
import { eventRow } from './board';

// Task detail (§6): criteria rows, the verifier's box, the audit trail and the
// pinned action row. The reason strings are load-bearing: the server's ledger
// (`describeLedgerEvent`, apps/web-api/src/services/teams.service.ts) labels a
// human `done` whose reason contains `verifier bypassed` "Operator approved" —
// the same constant the web's TaskActions.tsx sends.

export const APPROVE_REASON = 'approved by operator, verifier bypassed';

export type TaskAction = 'send-back' | 'approve';

/**
 * Which of the two verbs a status offers. `needs_revision` is the verifier's
 * rejection (approve over it, or return it with a note); `blocked` and
 * `running` can be closed by the operator or sent back with a note. Every other
 * state has nothing to decide, so the row is not rendered (§11a rule 2).
 */
export function taskActions(status: KanbanTaskStatus): TaskAction[] {
  switch (status) {
    case 'needs_revision':
    case 'blocked':
    case 'running':
      return ['send-back', 'approve'];
    default:
      return [];
  }
}

/** The status each verb moves the task to. */
export const ACTION_TARGET: Record<TaskAction, KanbanTaskStatus> = {
  'send-back': 'needs_revision',
  approve: 'done',
};

/**
 * The action row's in-flight rule (§12 amendment 15): both buttons stay
 * disabled with `deciding…` until the task's status changes. A send-back on a
 * task already in `needs_revision` changes no status, so it settles when the
 * refetched task's `updatedAt` moves past the one seen at tap time.
 */
export function decisionSettled(
  pending: { target: KanbanTaskStatus; fromStatus: KanbanTaskStatus; fromUpdatedAt: string },
  task: Pick<KanbanTask, 'status' | 'updatedAt'>,
): boolean {
  if (task.status !== pending.fromStatus) return true;
  return task.status === pending.target && task.updatedAt !== pending.fromUpdatedAt;
}

export interface CriterionRow {
  text: string;
  glyph: '✓' | '✗' | '·';
  word: string;
}

/**
 * `acceptanceCriteria` is free text; each non-empty line (list markers
 * stripped) is one criterion. The wire carries no per-criterion verdict, so a
 * row is `✓ met` only on a `done` task the verifier passed, `✗ unmet` only
 * when there is one criterion and the verifier rejected the task, and `· open`
 * otherwise — what the verifier actually said is quoted in its own box.
 */
export function criteriaRows(
  criteria: string | null,
  status: KanbanTaskStatus,
  bypassed: boolean,
): CriterionRow[] {
  const lines = (criteria ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)]|\[[ xX]\])\s*/, '').trim())
    .filter(Boolean);
  return lines.map((text) => {
    if (status === 'done' && !bypassed) return { text, glyph: '✓', word: 'met' };
    if (status === 'needs_revision' && lines.length === 1)
      return { text, glyph: '✗', word: 'unmet' };
    return { text, glyph: '·', word: 'open' };
  });
}

export interface VerifierVerdict {
  reason: string;
  actor: string;
  time: string;
}

/** The newest `status_changed → needs_revision` with a reason, when the task
 *  is still in `needs_revision` — the verdict the operator is deciding over. */
export function verifierVerdict(
  events: readonly KanbanEvent[],
  taskId: string,
  status: KanbanTaskStatus,
): VerifierVerdict | null {
  if (status !== 'needs_revision') return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.taskId !== taskId || e.kind !== 'status_changed') continue;
    if (e.data.to !== 'needs_revision') continue;
    const reason = e.data.reason;
    if (typeof reason !== 'string' || !reason) return null;
    return { reason, actor: e.actor, time: clock(Date.parse(e.createdAt)) };
  }
  return null;
}

/** Whether the task was closed by the operator over the verifier. */
export function wasBypassed(events: readonly KanbanEvent[], taskId: string): boolean {
  return events.some(
    (e) =>
      e.taskId === taskId &&
      e.kind === 'status_changed' &&
      e.data.to === 'done' &&
      typeof e.data.reason === 'string' &&
      e.data.reason.includes('verifier bypassed'),
  );
}

/**
 * The audit trail, oldest first: the board's recent events for this task
 * (the board caps them at 100, so a long-lived task's earliest lines may be
 * gone) with each comment's text folded in from `getTask`. Heartbeats dropped.
 */
export function auditRows(
  events: readonly KanbanEvent[],
  comments: readonly KanbanComment[],
  taskId: string,
): RowData[] {
  const commentRows = comments.map((c) => ({
    at: c.createdAt,
    row: {
      glyph: '·' as const,
      word: 'comment',
      subject: c.author,
      result: c.body,
      time: clock(Date.parse(c.createdAt)),
    },
  }));
  const eventRows = events
    .filter((e) => e.taskId === taskId && e.kind !== 'heartbeat' && e.kind !== 'commented')
    .map((e) => ({
      at: e.createdAt,
      row: { ...eventRow(e), subject: e.actor, result: detail(e) },
    }));
  return [...eventRows, ...commentRows].sort((a, b) => a.at.localeCompare(b.at)).map((r) => r.row);
}

function detail(e: KanbanEvent): string | undefined {
  if (e.kind === 'status_changed') {
    const reason = typeof e.data.reason === 'string' ? e.data.reason : '';
    const from = typeof e.data.from === 'string' ? e.data.from : '';
    return [from ? `from ${from}` : '', reason].filter(Boolean).join(' · ') || undefined;
  }
  if (e.kind === 'assigned' && typeof e.data.assignee === 'string') return e.data.assignee;
  if (e.kind === 'run_completed' && typeof e.data.summary === 'string') return e.data.summary;
  return undefined;
}

/** `1 / 3`, `0 / ∞`. */
export function retriesLabel(task: Pick<KanbanTask, 'retryCount' | 'maxRetries'>): string {
  return `${task.retryCount} / ${task.maxRetries ?? '∞'}`;
}
