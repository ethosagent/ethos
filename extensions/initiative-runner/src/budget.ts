import type { ExplorationRow } from '@ethosagent/types';

export interface PlanDayInput {
  usdPerDay: number;
  open: ExplorationRow[];
  windowsPerDay: number;
  /** Held back for the day's scan. */
  scanReserveUsd: number;
  /** Share of usdPerDay held back for briefs (0.15). */
  briefReserveShare: number;
  /** ISO start times for today's windows, in order. The caller derives them from the schedule; no clock is read here. */
  windowTimes: string[];
  /** Smallest useful window. Fewer windows run when the pool cannot fund this many. Default 0. */
  minWindowUsd?: number;
  /** Last window start per exploration id (ISO). Missing = never run = oldest. */
  lastRunAt?: Record<string, string>;
}

export interface DayPlan {
  windowsToRun: Array<{ explorationId: string; at: string }>;
  skipped: number;
  /** Window pool split evenly over the windows that will run (0 when none). */
  perWindowUsd: number;
  briefReserveUsd: number;
}

/**
 * Pool = usdPerDay - scanReserveUsd - usdPerDay * briefReserveShare, floored at 0.
 * Window count = min(windowsPerDay, windowTimes, open, floor(pool / minWindowUsd)).
 * Rotation: oldest `lastRunAt` first (never run first); ties keep the order of `open`,
 * which the store returns oldest-created first. skipped = open explorations given no window.
 */
export function planDay(i: PlanDayInput): DayPlan {
  const briefReserveUsd = Math.max(0, i.usdPerDay) * i.briefReserveShare;
  const pool = Math.max(0, i.usdPerDay - i.scanReserveUsd - briefReserveUsd);
  const min = i.minWindowUsd ?? 0;
  const funded = pool <= 0 ? 0 : min > 0 ? Math.floor(pool / min) : Number.POSITIVE_INFINITY;
  const count = Math.max(0, Math.min(i.windowsPerDay, i.windowTimes.length, i.open.length, funded));

  const stamp = (r: ExplorationRow): string => i.lastRunAt?.[r.id] ?? '';
  const ordered = i.open
    .map((row, idx) => ({ row, idx }))
    .sort((a, b) => {
      const sa = stamp(a.row);
      const sb = stamp(b.row);
      if (sa !== sb) return sa < sb ? -1 : 1;
      return a.idx - b.idx;
    })
    .map((e) => e.row);

  const windowsToRun = ordered.slice(0, count).map((row, n) => ({
    explorationId: row.id,
    at: i.windowTimes[n] as string,
  }));
  return {
    windowsToRun,
    skipped: i.open.length - windowsToRun.length,
    perWindowUsd: count > 0 ? pool / count : 0,
    briefReserveUsd,
  };
}

export interface WindowGuard {
  onUsage(costUsd: number): void;
  spentUsd(): number;
  /**
   * 'day' or 'exploration' once aborted, else null. Day wins when both are out. A non-finite or
   * negative cost cannot be trusted to stay under a cap, so it ends the window as 'day'
   * (pinned by budget.test.ts, 'invalid cost').
   */
  endReason(): 'day' | 'exploration' | null;
}

/**
 * Aborts when either remaining cap drops below one call's reserve. The in-flight call still
 * finishes and is counted, so overshoot is at most one call (R10).
 */
export function createWindowGuard(
  caps: { dayRemainingUsd: number; explorationRemainingUsd: number; perCallReserveUsd: number },
  abort: AbortController,
): WindowGuard {
  let spent = 0;
  let reason: 'day' | 'exploration' | null = null;

  const check = (): void => {
    if (reason) return;
    if (caps.dayRemainingUsd - spent < caps.perCallReserveUsd) reason = 'day';
    else if (caps.explorationRemainingUsd - spent < caps.perCallReserveUsd) reason = 'exploration';
    if (reason) abort.abort();
  };
  check();

  return {
    onUsage(costUsd) {
      if (!Number.isFinite(costUsd) || costUsd < 0) {
        if (!reason) {
          reason = 'day';
          abort.abort();
        }
        return;
      }
      spent += costUsd;
      check();
    },
    spentUsd: () => spent,
    endReason: () => reason,
  };
}
