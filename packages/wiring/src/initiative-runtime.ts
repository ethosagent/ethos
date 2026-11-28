import { join } from 'node:path';
import { nextRunForSchedule } from '@ethosagent/cron';
import {
  BRIEF_RESERVE_SHARE,
  effectiveEnabled,
  type InitiativeRunner,
  type InitiativeSettings,
  type LoadedInitiative,
  loadInitiativeSettings,
  PER_CALL_RESERVE_USD,
  planDay,
  SCAN_CAP_USD,
} from '@ethosagent/initiative-runner';
import type { Constitution, InitiativeRow, WindowKind } from '@ethosagent/types';
import {
  createInitiativeLoader,
  createInitiativeRunnerFor,
  type InitiativeEnablement,
  readInitiativeConstitution,
} from './initiatives';

const DAY_MS = 86_400_000;
const MAX_TIMES_PER_SCHEDULE = 48;
const SWITCHED_OFF_FILE = '.switched-off.json';

export type InitiativeRuntimeDeps = Parameters<typeof createInitiativeRunnerFor>[0] & {
  /** Re-reads settings and the constitution so chat tool visibility follows a toggle. */
  enablement?: Pick<InitiativeEnablement, 'reload'>;
};

export interface InitiativeTickReport {
  ran: Array<{
    initiativeId: string;
    kind: WindowKind;
    spentUsd: number;
    endReason: string;
  }>;
  /** Initiatives this tick paused (a switch-off, or 14 days of silence on a self-started one). */
  paused: string[];
  /** Initiatives this tick resumed after their personality was switched back on. */
  resumed: string[];
  /** Why the tick did nothing at all. */
  skipped?: 'busy' | 'disposed' | 'no-ledger';
}

export interface InitiativeRuntime {
  /** The manual run surface (`ethos initiatives run`) the tick drives. */
  runner: InitiativeRunner;
  /**
   * One scheduled pass. Re-reads `constitution.initiatives` and every `settings.yaml` through the
   * compose-time Storage, so a lowered limit or a switch-off applies now; the rest of the
   * constitution still needs a restart (plan O-3). Never throws: failures go to `log.warn`.
   */
  tick(now?: Date): Promise<InitiativeTickReport>;
  /** Idempotent. A tick in flight finishes its current run and starts no other. */
  dispose(): void;
}

/** Every start time of `schedules` inside the UTC day of `now` (the day the ledger charges), sorted. */
function timesOnDay(schedules: readonly string[], now: Date): string[] {
  const dayStart = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const times = new Set<string>();
  for (const schedule of schedules) {
    let cursor = new Date(dayStart - 1);
    for (let i = 0; i < MAX_TIMES_PER_SCHEDULE; i++) {
      const next = nextRunForSchedule(schedule, cursor);
      if (next === null || next.getTime() >= dayStart + DAY_MS) break;
      times.add(next.toISOString());
      cursor = next;
    }
  }
  return [...times].sort();
}

/**
 * Task 5.5. Driven by the `initiative-tick` system job (every 5 minutes, system-jobs.ts). Owns the schedule; `createInitiativeRunnerFor` owns one run. Cron grants nothing: the
 * `initiative-tick` job carries no prompt and no toolset, and a run's tools come only from the
 * initiative's personality through `buildReadOnlyRegistry`.
 *
 * Per tick: pause (or resume) by switch, pause idle self-started initiatives, then for each
 * enabled initiative, in order: a first survey, the day's scan (self-start on), and the windows
 * `planDay` assigns to start times in (previous tick, now]. A window missed while the process was
 * down is skipped, never replayed (the same `skip` policy cron's system jobs use).
 *
 * Limitations: the "paused by a switch-off" marker lives in
 * `personalities/<id>/initiatives/.switched-off.json`; a self-started initiative resumes as
 * `active` (paused -> self_started is not an allowed move). Day and window times are UTC days.
 * The operator ceilings `maxUsdPerDay` and `maxUsdPerDayPerPersonality` clamp each initiative's
 * own cap (`createInitiativeLoader`), and the runner sums the day's spend across initiatives at
 * run start (`totalsRemainingUsd`, pinned by day-caps.test.ts). Runs sharing a cap are serialised
 * in this process only; a CLI run beside `serve` can still overlap (day-caps.ts `KeyedLock`).
 */
export function createInitiativeRuntime(deps: InitiativeRuntimeDeps): InitiativeRuntime {
  const runner = createInitiativeRunnerFor(deps);
  const load = createInitiativeLoader(deps);
  const { storage, dataDir, ledger, personalities } = deps;
  const store = ledger.store;
  const onError = (err: unknown): void =>
    deps.log?.warn(`initiative tick: ${err instanceof Error ? err.message : String(err)}`);
  let busy = false;
  let disposed = false;
  let lastTickAt: Date | null = null;
  const lastRunAt: Record<string, string> = {};

  const markerPath = (personalityId: string): string =>
    join(dataDir, 'personalities', personalityId, 'initiatives', SWITCHED_OFF_FILE);

  async function readMarker(personalityId: string): Promise<Set<string>> {
    try {
      const raw = await storage.read(markerPath(personalityId));
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []);
    } catch (err) {
      onError(err);
      return new Set();
    }
  }

  async function writeMarker(personalityId: string, ids: Set<string>): Promise<void> {
    const path = markerPath(personalityId);
    try {
      await storage.mkdir(join(path, '..'));
      await storage.writeAtomic(path, JSON.stringify([...ids].sort()));
    } catch (err) {
      onError(err);
    }
  }

  /** Pause every running initiative of a switched-off personality; resume the ones this paused when it is back on. */
  async function applySwitch(
    personalityId: string,
    on: boolean,
    report: InitiativeTickReport,
  ): Promise<void> {
    const marker = await readMarker(personalityId);
    let changed = false;
    const rows = store.list({ personalityId });
    if (!on) {
      for (const row of rows) {
        if (row.state !== 'active' && row.state !== 'self_started') continue;
        store.transitionInitiative(row.id, 'paused', 'personality switched off');
        marker.add(row.id);
        changed = true;
        report.paused.push(row.id);
      }
    } else {
      for (const id of [...marker]) {
        const row = rows.find((r) => r.id === id);
        if (row?.state === 'paused') {
          store.transitionInitiative(id, 'active', 'personality switched back on');
          report.resumed.push(id);
        }
        marker.delete(id);
        changed = true;
      }
    }
    if (changed) await writeMarker(personalityId, marker);
  }

  async function tickInitiative(
    row: InitiativeRow,
    settings: InitiativeSettings,
    now: Date,
    since: Date,
    report: InitiativeTickReport,
  ): Promise<void> {
    let loaded: LoadedInitiative | null;
    try {
      loaded = await load(row.id); // also primes the ledger cap; unloaded reports $0
    } catch (err) {
      onError(err);
      return;
    }
    if (loaded === null) return;
    const day = now.toISOString().slice(0, 10);
    const left = () => {
      const b = store.budget(row.id, day);
      return b.capUsd - b.spentUsd;
    };
    const attempt = async (
      kind: WindowKind,
      run: () => ReturnType<InitiativeRunner['runSurvey']>,
    ) => {
      if (disposed) return;
      try {
        const r = await run();
        report.ran.push({
          initiativeId: row.id,
          kind: r.kind,
          spentUsd: r.spentUsd,
          endReason: r.endReason,
        });
      } catch (err) {
        onError(
          new Error(
            `${kind} for "${row.id}" failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    };

    const history = ledger.windows(row.id);
    if (left() < PER_CALL_RESERVE_USD) return;
    if (!history.some((w) => w.kind === 'survey')) {
      await attempt('survey', () => runner.runSurvey(row.id));
    }
    const scanned = history.some((w) => w.kind === 'scan' && w.started.slice(0, 10) === day);
    if (settings.selfStart && row.origin === 'human' && !scanned && left() >= SCAN_CAP_USD) {
      await attempt('scan', () => runner.runScan(row.id));
    }

    const times = timesOnDay(loaded.file.timeline.explore_windows, now);
    const open = store.explorations(row.id, ['exploring', 'stalled']);
    if (times.length === 0 || open.length === 0) return;
    const plan = planDay({
      usdPerDay: loaded.file.budget.usd_per_day,
      open,
      windowsPerDay: times.length,
      scanReserveUsd: settings.selfStart ? SCAN_CAP_USD : 0,
      briefReserveShare: BRIEF_RESERVE_SHARE,
      windowTimes: times,
      minWindowUsd: PER_CALL_RESERVE_USD,
      lastRunAt,
    });
    for (const slot of plan.windowsToRun) {
      const at = Date.parse(slot.at);
      if (at <= since.getTime() || at > now.getTime() || left() < PER_CALL_RESERVE_USD) continue;
      lastRunAt[slot.explorationId] = now.toISOString();
      await attempt('window', () => runner.runWindow(row.id, slot.explorationId));
    }
  }

  async function runTick(
    now: Date,
    since: Date,
    constitution: Constitution,
    report: InitiativeTickReport,
  ): Promise<void> {
    report.paused.push(...runner.pauseIdle());
    for (const { id } of personalities.list()) {
      if (disposed) return;
      const settings = (await loadInitiativeSettings(storage, dataDir, id)).settings;
      const on = effectiveEnabled(settings, constitution);
      await applySwitch(id, on, report);
      if (!on) continue;
      for (const row of store.list({ personalityId: id, states: ['active', 'self_started'] })) {
        if (disposed) return;
        await tickInitiative(row, settings, now, since, report);
      }
    }
  }

  return {
    runner,
    async tick(now = new Date()) {
      const report: InitiativeTickReport = { ran: [], paused: [], resumed: [] };
      if (disposed) return { ...report, skipped: 'disposed' };
      if (busy) return { ...report, skipped: 'busy' };
      busy = true;
      const since = lastTickAt ?? now; // first tick after a start replays nothing
      lastTickAt = now;
      try {
        try {
          await deps.enablement?.reload();
        } catch (err) {
          onError(err);
        }
        // No ledger file means no initiative was ever saved: nothing to read, nothing to spend.
        if (!(await ledger.ready())) return { ...report, skipped: 'no-ledger' };
        await runTick(now, since, await readInitiativeConstitution(storage, dataDir), report);
      } catch (err) {
        onError(err);
      } finally {
        busy = false;
      }
      return report;
    },
    dispose() {
      disposed = true;
    },
  };
}
