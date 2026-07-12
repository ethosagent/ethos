import type { AgentLoop } from '@ethosagent/core';
import { isValidSchedule, nextRunForSchedule } from '@ethosagent/cron';
import { noopLogger } from '@ethosagent/logger';
import type { PluginLoader } from '@ethosagent/plugin-loader';
import type { Logger, SessionStore } from '@ethosagent/types';
import { type RefreshDashboardsHandle, refreshSinglePanel } from './dashboard-refresh';
import type { DashboardPanel } from './dashboards.service';

/**
 * Data source the scheduler sweeps. The `DashboardsService` satisfies this
 * structurally — it is the refresh handle plus the two list reads the sweep
 * needs.
 */
export interface DashboardRefreshSource extends RefreshDashboardsHandle {
  list(userId: string): Array<{ id: string; cronSchedule: string | null }>;
  listLivePanels(dashboardId: string): DashboardPanel[];
}

export interface DashboardRefreshSchedulerConfig {
  dashboards: DashboardRefreshSource;
  agentLoop: AgentLoop;
  pluginLoader?: PluginLoader;
  /**
   * Session store used to garbage-collect the ephemeral session each prompt
   * refresh spawns — required so a 1-minute auto-refresh does not leak junk
   * sessions into sessions.db.
   */
  sessions: SessionStore;
  /** Owner whose dashboards are swept. Single-user today. Default 'default-user'. */
  userId?: string;
  /** Tick cadence in ms. Default 60_000 (1 min). */
  tickIntervalMs?: number;
  logger?: Logger;
}

/**
 * Cron-driven dashboard panel refresh, owned by the dashboard extension.
 *
 * Replaces the hand-rolled `isCronDue` + 60s `setInterval` poller that lived in
 * `apps/web-api` and duplicated (buggily) the schedule logic the `@ethosagent/
 * cron` engine already implements. Every due-check now runs through the cron
 * extension's real schedule engine (`isValidSchedule` / `nextRunForSchedule`),
 * so full 5-field cron — step values, day-of-month, month, ranges — is honoured
 * instead of the previous minute/hour/day-of-week-only subset.
 *
 * A re-entrancy guard skips a tick while the previous sweep is still running,
 * so a slow refresh cannot double-fire on the next tick. Prompt refreshes run
 * as ephemeral sessions (see `RefreshDeps.sessions`).
 */
export class DashboardRefreshScheduler {
  private readonly config: DashboardRefreshSchedulerConfig;
  private readonly userId: string;
  private readonly tickIntervalMs: number;
  private readonly logger: Logger;
  /** In-memory last-run stamp for dashboard-level cron (mirrors the old poller). */
  private readonly dashboardLastRun = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(config: DashboardRefreshSchedulerConfig) {
    this.config = config;
    this.userId = config.userId ?? 'default-user';
    this.tickIntervalMs = config.tickIntervalMs ?? 60_000;
    this.logger = config.logger ?? noopLogger;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
    // Don't keep the process alive for the refresh loop.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One sweep. Public for tests; the timer calls it on each tick. */
  async tick(): Promise<void> {
    if (this.sweeping) return; // re-entrancy guard — no overlapping double-fire
    this.sweeping = true;
    try {
      await this.sweep();
    } catch (err) {
      this.logger.warn?.('dashboard refresh sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.sweeping = false;
    }
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    const deps = {
      dashboards: this.config.dashboards,
      pluginLoader: this.config.pluginLoader,
      agentLoop: this.config.agentLoop,
      sessions: this.config.sessions,
    };

    for (const dash of this.config.dashboards.list(this.userId)) {
      const panels = this.config.dashboards.listLivePanels(dash.id);

      // Dashboard-level cron: refresh ALL live panels when due.
      if (
        dash.cronSchedule &&
        isDue(dash.cronSchedule, this.dashboardLastRun.get(dash.id) ?? null, now)
      ) {
        this.dashboardLastRun.set(dash.id, now);
        for (const panel of panels) {
          await refreshSinglePanel(panel, deps);
        }
        continue; // skip per-panel cron this tick
      }

      // Per-panel cron.
      for (const panel of panels) {
        if (!panel.cronSchedule) continue;
        if (!isDue(panel.cronSchedule, panel.lastRunAt, now)) continue;
        await refreshSinglePanel(panel, deps);
      }
    }
  }
}

/**
 * Due-check via the cron extension's schedule engine. A schedule with no prior
 * run is due immediately (mirrors the old poller); otherwise it is due once the
 * next scheduled instant after the last run has passed.
 */
function isDue(schedule: string, lastRunAt: number | null, now: number): boolean {
  if (!isValidSchedule(schedule)) return false;
  if (lastRunAt == null) return true;
  const next = nextRunForSchedule(schedule, new Date(lastRunAt));
  return next != null && next.getTime() <= now;
}
