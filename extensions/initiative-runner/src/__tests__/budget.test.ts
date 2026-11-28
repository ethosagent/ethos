import type { ExplorationRow } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createWindowGuard, planDay } from '../budget';

function row(id: string): ExplorationRow {
  return {
    id,
    initiativeId: 'ini-1',
    ideaId: null,
    question: `q ${id}`,
    state: 'exploring',
    budgetUsd: 1,
    spentUsd: 0,
    deadline: '2030-01-01',
    estimateUsd: null,
  };
}

const times = ['2030-01-01T09:00:00Z', '2030-01-01T15:00:00Z', '2030-01-01T21:00:00Z'];

describe('planDay', () => {
  // The plan's "page readout" numbers were not found in plan/ or docs/. These are derived from the
  // formula: pool = 3 - 0.3 scan - 0.45 brief (15%) = 2.25; 2 windows -> 1.125 each; 3 open -> 1 skipped.
  it('spec slider example', () => {
    const r = planDay({
      usdPerDay: 3,
      open: [row('a'), row('b'), row('c')],
      windowsPerDay: 2,
      scanReserveUsd: 0.3,
      briefReserveShare: 0.15,
      windowTimes: times,
    });
    expect(r.windowsToRun).toEqual([
      { explorationId: 'a', at: times[0] },
      { explorationId: 'b', at: times[1] },
    ]);
    expect(r.skipped).toBe(1);
    expect(r.perWindowUsd).toBeCloseTo(1.125, 10);
    expect(r.briefReserveUsd).toBeCloseTo(0.45, 10);
  });

  it('day budget out → remaining windows skipped', () => {
    const r = planDay({
      usdPerDay: 1,
      open: [row('a'), row('b')],
      windowsPerDay: 2,
      scanReserveUsd: 0.5,
      briefReserveShare: 0.15,
      minWindowUsd: 0.2,
      windowTimes: times,
    });
    // pool = 1 - 0.5 - 0.15 = 0.35 -> floor(0.35 / 0.2) = 1 window
    expect(r.windowsToRun).toHaveLength(1);
    expect(r.skipped).toBe(1);
  });

  it('windows rotate oldest first', () => {
    const r = planDay({
      usdPerDay: 3,
      open: [row('a'), row('b'), row('c')],
      windowsPerDay: 2,
      scanReserveUsd: 0,
      briefReserveShare: 0.15,
      lastRunAt: { a: '2030-01-01T08:00:00Z', b: '2029-12-30T08:00:00Z' },
      windowTimes: times,
    });
    // c never ran (oldest), then b (older than a)
    expect(r.windowsToRun.map((w) => w.explorationId)).toEqual(['c', 'b']);
  });

  it('zero budget runs nothing', () => {
    const r = planDay({
      usdPerDay: 0,
      open: [row('a')],
      windowsPerDay: 2,
      scanReserveUsd: 0.3,
      briefReserveShare: 0.15,
      windowTimes: times,
    });
    expect(r.windowsToRun).toEqual([]);
    expect(r.skipped).toBe(1);
    expect(r.perWindowUsd).toBe(0);
  });

  it('no open explorations → nothing to run, nothing skipped', () => {
    const r = planDay({
      usdPerDay: 3,
      open: [],
      windowsPerDay: 2,
      scanReserveUsd: 0.3,
      briefReserveShare: 0.15,
      windowTimes: times,
    });
    expect(r).toMatchObject({ windowsToRun: [], skipped: 0 });
  });

  it('never schedules more windows than windowTimes', () => {
    const r = planDay({
      usdPerDay: 3,
      open: [row('a'), row('b'), row('c')],
      windowsPerDay: 3,
      scanReserveUsd: 0,
      briefReserveShare: 0,
      windowTimes: [times[0] as string],
    });
    expect(r.windowsToRun).toHaveLength(1);
    expect(r.skipped).toBe(2);
  });
});

describe('createWindowGuard', () => {
  it('R10 abort leaves at most one call over', () => {
    const abort = new AbortController();
    const g = createWindowGuard(
      { dayRemainingUsd: 10, explorationRemainingUsd: 1, perCallReserveUsd: 0.1 },
      abort,
    );
    g.onUsage(0.5);
    expect(abort.signal.aborted).toBe(false);
    g.onUsage(0.45); // remaining 0.05 < 0.1 reserve
    expect(abort.signal.aborted).toBe(true);
    expect(g.endReason()).toBe('exploration');
    // the in-flight call finishes and is still counted; overshoot is bounded by that one call
    g.onUsage(0.1);
    expect(g.spentUsd()).toBeCloseTo(1.05, 10);
    expect(g.spentUsd() - 1).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it('reports the day cap when it is the tighter one', () => {
    const abort = new AbortController();
    const g = createWindowGuard(
      { dayRemainingUsd: 0.3, explorationRemainingUsd: 5, perCallReserveUsd: 0.1 },
      abort,
    );
    expect(g.endReason()).toBeNull();
    g.onUsage(0.25);
    expect(abort.signal.aborted).toBe(true);
    expect(g.endReason()).toBe('day');
  });

  it('aborts at once when the caps start below one reserve', () => {
    const abort = new AbortController();
    const g = createWindowGuard(
      { dayRemainingUsd: 0, explorationRemainingUsd: 1, perCallReserveUsd: 0.1 },
      abort,
    );
    g.onUsage(0);
    expect(abort.signal.aborted).toBe(true);
    expect(g.endReason()).toBe('day');
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])('invalid cost %s aborts', (cost) => {
    const abort = new AbortController();
    const g = createWindowGuard(
      { dayRemainingUsd: 10, explorationRemainingUsd: 10, perCallReserveUsd: 0.1 },
      abort,
    );
    g.onUsage(cost);
    expect(abort.signal.aborted).toBe(true);
    expect(g.endReason()).toBe('day');
    expect(Number.isFinite(g.spentUsd())).toBe(true);
  });
});
