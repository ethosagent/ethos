import type { KanbanMemberStats } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { formatMemberSuccess } from '../member-stats';

function stats(partial: Partial<KanbanMemberStats>): KanbanMemberStats {
  return {
    teamId: 'team-a',
    memberId: 'engineer',
    ticketsCompleted: 0,
    ticketsFailed: 0,
    ticketsOrphaned: 0,
    lastUpdatedAt: new Date(0).toISOString(),
    ...partial,
  };
}

describe('formatMemberSuccess', () => {
  it('returns the no-record state when stats are undefined', () => {
    expect(formatMemberSuccess(undefined)).toEqual({ kind: 'no-record' });
  });

  it('returns the no-record state when all counters are zero', () => {
    expect(formatMemberSuccess(stats({}))).toEqual({ kind: 'no-record' });
  });

  it('computes a 100% rate for an all-completed record', () => {
    expect(formatMemberSuccess(stats({ ticketsCompleted: 4 }))).toEqual({
      kind: 'rate',
      ratePercent: 100,
      completed: 4,
      total: 4,
    });
  });

  it('computes a 0% rate for an all-failed record', () => {
    expect(formatMemberSuccess(stats({ ticketsFailed: 3 }))).toEqual({
      kind: 'rate',
      ratePercent: 0,
      completed: 0,
      total: 3,
    });
  });

  it('counts failed and orphaned tickets against the success ratio', () => {
    // 2 completed of (2 + 1 failed + 1 orphaned) = 4 total -> 50%.
    expect(
      formatMemberSuccess(stats({ ticketsCompleted: 2, ticketsFailed: 1, ticketsOrphaned: 1 })),
    ).toEqual({ kind: 'rate', ratePercent: 50, completed: 2, total: 4 });
  });

  it('rounds the rate to a whole percent', () => {
    // 1 of 3 = 33.33% -> 33.
    expect(formatMemberSuccess(stats({ ticketsCompleted: 1, ticketsFailed: 2 }))).toEqual({
      kind: 'rate',
      ratePercent: 33,
      completed: 1,
      total: 3,
    });
  });
});
