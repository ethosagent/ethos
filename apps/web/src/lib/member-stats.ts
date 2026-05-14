import type { KanbanMemberStats } from '@ethosagent/web-contracts';

/**
 * Read-only presentation of a team member's success rate, for the Roster
 * panel. Success rate is `completed / (completed + failed + orphaned)`.
 *
 * A member with no recorded terminal outcomes (no stat row, or all counters
 * zero) is `no-record` rather than a misleading 0% or 100% — the panel renders
 * that distinctly.
 */
export type MemberSuccess =
  | { kind: 'no-record' }
  | { kind: 'rate'; ratePercent: number; completed: number; total: number };

export function formatMemberSuccess(stats: KanbanMemberStats | undefined): MemberSuccess {
  if (!stats) return { kind: 'no-record' };
  const total = stats.ticketsCompleted + stats.ticketsFailed + stats.ticketsOrphaned;
  if (total === 0) return { kind: 'no-record' };
  return {
    kind: 'rate',
    ratePercent: Math.round((stats.ticketsCompleted / total) * 100),
    completed: stats.ticketsCompleted,
    total,
  };
}
