import { AsyncResource } from 'node:async_hooks';
import type { AgentLoop } from '@ethosagent/core';
import type {
  ArtifactChange,
  BackgroundJob,
  BackgroundJobEvent,
  HookRegistry,
  JobClaimFence,
  JobRunner,
  JobRunnerContext,
  JobRunnerRegistry,
  JobSteer,
  JobStore,
  RunUpdateDigest,
} from '@ethosagent/types';
import { answerSuffix, isClaimLostError, JOB_ABORTED_BY_SHUTDOWN } from '@ethosagent/types';
import { EthosJobRunner } from './ethos-job-runner';
import { createJobSteerSink } from './job-steer-sink';
import { resumeContextFor } from './resume';
import { RunDigestBoard } from './run-digest';
import { createLogSink, createTextSink } from './run-sinks';
import { capText, extractSummarySection, SUMMARY_RESULT_CAP } from './summary';

export {
  ETHOS_RUNNER_CAPABILITIES,
  ETHOS_RUNNER_NAME,
  EthosJobRunner,
  jobRoomAudience,
} from './ethos-job-runner';
export {
  createJobControl,
  type JobControl,
  type JobControlDeps,
  jobActionAllowed,
  type SteerOutcome,
  type StopOutcome,
  type TailOutcome,
} from './job-control';
export { formatJobEventLine } from './job-event-format';
export {
  isActiveJob,
  isJobRef,
  JOB_REF_SHAPE,
  type JobRefResolution,
  resolveJobRef,
  steerRefusalText,
  stopRefusalText,
  unreadSteerPreview,
} from './job-ref';
export { createJobSteerSink, type JobSteerSink } from './job-steer-sink';
export { BoundedLogBuffer, type RunnerLogLine } from './log-buffer';
export { resumePrompt } from './resume';
// Every background job runs in summary mode, whatever the runner: the parent
// re-ingests only a bounded digest. Exported so an out-of-process runner
// appends the SAME instruction rather than growing a third copy of it.
export { SUMMARY_INSTRUCTION } from './summary';
export { narrowedToolset } from './toolset-narrowing';

// ---------------------------------------------------------------------------
// BackgroundExecutor — the detached background engine for background sub-agents.
//
// It owns the pool of concurrently-running detached child turns. Each job is a
// durable row in a shared `jobs.db` (the JobStore); the executor claims queued
// rows, runs the child AgentLoop under its OWN AbortController (never chained to
// a parent turn signal — that is the load-bearing design point that makes a job
// survive the parent turn ending), heartbeats it, watches for cancellation and
// spend caps, and writes the terminal transition back to the store.
//
// Cap enforcement split (do NOT mistake this for a gap):
//   - Per-root / per-personality CONCURRENCY caps are enforced at the TOOL
//     boundary at spawn time (a different module owns that), not here.
//   - The executor enforces only (a) the global pool size (maxConcurrentJobs)
//     and (b) the aggregate per-root SPEND cap (maxRootBackgroundUsd).
// ---------------------------------------------------------------------------

export interface BackgroundExecutorConfig {
  /** Pool size — max jobs running concurrently in this process. */
  maxConcurrentJobs: number;
  /** Heartbeat-age threshold for the stale sweep. NOT the sweep cadence. */
  staleMs: number;
  /** Per-active-job heartbeat cadence, and the periodic stale-sweep cadence. */
  heartbeatMs: number;
  /** A queued row older than this is expired (no executor ever claimed it). */
  queuedTtlMs: number;
  /** Finite default 5.0; null opts out of the aggregate per-root spend cap. */
  maxRootBackgroundUsd: number | null;
  /** Backstop claim poll interval. Default 3_000. */
  pollMs?: number;
  /** Retention GC window: terminal rows older than this are pruned. 0/absent disables. */
  retentionMs?: number;
  /**
   * Requeue an interrupted run (graceful stop or crash) instead of aborting or
   * staling it, so a successor with the same affinity continues it. Default
   * false here — a standalone executor keeps today's behaviour; wiring passes
   * `background.resume_on_restart` (default true).
   */
  resumeOnRestart?: boolean;
  /** Automatic resumes per job before it falls back to abort/stale. Default 3. */
  maxResumes?: number;
  /** How long a requeued row waits for a successor, from the requeue. Default 24 h. */
  resumeTtlMs?: number;
}

export interface BackgroundExecutorDeps {
  store: JobStore;
  /**
   * The in-process AgentLoop, used to build the DEFAULT runner (`EthosJobRunner`).
   * Still required: every deployment has one, and a job with no `runner` on its
   * row runs on it.
   */
  loop: AgentLoop;
  /**
   * Registry of additional runners, consulted when a job row names one
   * (`BackgroundJob.runner`). Only RESOLVED instances are visible — see
   * `DefaultJobRunnerRegistry`. Absent means "this deployment runs the default
   * runner and nothing else"; a row naming any other runner then fails with a
   * clear error rather than silently running on Ethos.
   */
  runners?: JobRunnerRegistry;
  /** This process's identity, stamped on claims. */
  owner: string;
  /**
   * F06 — which queued work this executor may inherit. On `shutdown()` its
   * not-yet-started rows are handed back under this label
   * (`JobStore.releaseQueued`), and an executor built with the SAME affinity —
   * the replacement loop after a live bot edit, or the next boot's — adopts
   * them (`claimNextQueued`'s `adopt`). Wiring derives it from the loop's
   * profile and bot identity (packages/wiring/src/build-agent-loop.ts), so one
   * bot's queued jobs never move to another bot. Absent: queued rows stay bound
   * to `owner`, as before.
   */
  affinity?: string;
  /**
   * The affinity stamped on a resumable run (`setResumeAffinity`), set only
   * when it survives a process restart (a bot key or a `jobAffinity` host label,
   * `resolveJobAffinity` in packages/wiring/src/job-affinity.ts); a pid
   * affinity never auto-resumes (D6). Absent = this executor never auto-resumes.
   */
  resumeAffinity?: string;
  config: BackgroundExecutorConfig;
  /** Optional log sink. Library code never touches console.* — use this or nothing. */
  log?: (msg: string) => void;
  /**
   * Optional hook registry. When present, the executor fires the
   * `on_background_job_complete` void hook on every terminal transition, in
   * addition to any `onComplete` subscribers. Absent in standalone deployments.
   */
  hooks?: HookRegistry;
  /**
   * Phase 5 — withdraw whatever question this job is parked on when its run is
   * aborted (cancel, spend cap, shutdown drain). Injected rather than imported:
   * the thing that owns pending questions is `ClarifyBridge` in
   * `@ethosagent/core`, and the executor deliberately does not know who asked
   * (§13.1's "THE SEAM" comment on `markJobBlocked` says the same).
   *
   * Without it, cancelling a `blocked` run aborts the controller but leaves the
   * question live on someone's phone for the rest of its window, and the
   * escalator's `finally` — which is what un-pauses the heartbeat — never runs.
   * Absent means today's behaviour: abort only.
   */
  cancelInteractions?: (jobId: string) => Promise<void>;
}

const DEFAULT_POLL_MS = 3_000;
const DEFAULT_MAX_RESUMES = 3;
const DEFAULT_RESUME_TTL_MS = 86_400_000;

/**
 * Per-artifact cap on the unified diff a runner hands over. The file list
 * (`path`, `+n / −n`) is always exact; only the diff BODY is bounded, because a
 * single generated-file rewrite would otherwise put megabytes in one audit row
 * that the inspector then has to read back. Same `[truncated]` marker the text
 * sink uses.
 */
const ARTIFACT_DIFF_CAP = 20_000;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Compact, single-line digest of a tool_start's args for the audit trail. Never
 * includes tool OUTPUT, only the invocation shape. Tiny and defensive — args may
 * be any shape or undefined (JSON.stringify(undefined) === undefined).
 */
function shortArgDigest(args: unknown): string {
  let raw: string;
  try {
    raw = typeof args === 'string' ? args : (JSON.stringify(args) ?? '');
  } catch {
    raw = String(args);
  }
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 117)}...` : collapsed;
}

/**
 * The card's `now` line for a tool call in flight: what the run is doing right
 * now, in one line. A FACT — never phrasing the copy module owns.
 */
function nowLine(toolName: string, args: unknown): string {
  const arg = shortArgDigest(args);
  const line = arg ? `${toolName} ${arg}` : toolName;
  return line.length > NOW_LINE_MAX_CHARS ? `${line.slice(0, NOW_LINE_MAX_CHARS - 1)}…` : line;
}

/**
 * The `error` on a run `shutdown()` aborted — the owning loop was disposed (a
 * process stop, or a live bot edit replacing its loop). Distinct from a user's
 * `task_cancel` ('cancelled by task_cancel'), so a surface can tell the origin
 * chat the job was interrupted rather than stay silent as it does on a cancel.
 * Defined in @ethosagent/types, where the job store's `listUndelivered` and the
 * gateway compare against it too; re-exported here for existing importers.
 */
export { JOB_ABORTED_BY_SHUTDOWN };

/**
 * Cadence of the per-job observe tick: cancel flag plus pending steers. Much
 * tighter than `heartbeatMs`, which now only bumps the beat (plan
 * background-job-steer D7). Two indexed point reads per running job per tick.
 */
export const JOB_OBSERVE_MS = 1_000;

/**
 * The abort reason of a run that lost its row (requeued or claimed away). The
 * abort listener in `startRun` skips `cancelInteractions` for it: the questions
 * under that job id may already be the same-process successor's.
 */
const OWNERSHIP_LOST = new Error('ownership of the job row was lost');

/** The claim a row was taken under; undefined only for a row that was never claimed. */
function fenceOf(job: BackgroundJob): JobClaimFence | undefined {
  return job.startedAt === undefined ? undefined : { owner: job.owner, startedAt: job.startedAt };
}

/** Cap on the `now` line — one line of the card, not a paragraph. */
const NOW_LINE_MAX_CHARS = 120;

export class BackgroundExecutor {
  private readonly store: JobStore;
  private readonly defaultRunner: JobRunner;
  private readonly runners: JobRunnerRegistry | undefined;
  /** This process's identity, stamped on claims. Read-only so callers (e.g. the
   *  gateway creating `/background` jobs) can stamp the same owner this executor
   *  claims by. */
  readonly owner: string;
  /** Stamped on a resumable run at claim (`setResumeAffinity`); see `deps.resumeAffinity`. */
  private readonly resumeAffinity: string | undefined;
  /** The label queued rows are handed back under, and adopted by (`affinity`). */
  private readonly releasedAs: string | undefined;
  private readonly config: BackgroundExecutorConfig;
  private readonly pollMs: number;
  private readonly log: ((msg: string) => void) | undefined;
  private readonly hooks: HookRegistry | undefined;
  private readonly cancelInteractions: ((jobId: string) => Promise<void>) | undefined;

  /** onComplete subscribers, invoked after every terminal transition. */
  private readonly completeHandlers: Array<(job: BackgroundJob) => void> = [];

  /** The run card's liveness feed (G9/D11/D20): per-run coalescing digests + onRunUpdate subscribers. */
  private readonly digests: RunDigestBoard;

  /** job.id -> the job's dedicated (unchained) AbortController. */
  private readonly activeControllers = new Map<string, AbortController>();
  /** job.id -> the claim the active run holds; fences its park/unpark writes. */
  private readonly activeFences = new Map<string, JobClaimFence>();
  /** job.id -> the in-flight run promise (resolves after its finish is written). */
  private readonly activeRuns = new Map<string, Promise<void>>();
  /** Per running job: one observe pass (cancel flag + pending steers). See `pokeSteer`. */
  private readonly observers = new Map<string, () => Promise<void>>();
  /**
   * job.id -> the requestId the run is parked on. Membership is the heartbeat
   * pause: while a job is in here its beat is skipped, so `reclaimStale` (which
   * only sweeps `running`) cannot mistake a parked question for a dead host.
   */
  private readonly blockedJobs = new Map<string, string>();

  private started = false;
  private shuttingDown = false;
  /** Set by `drain()`: claim nothing more, hand queued rows on instead. */
  private draining = false;
  /** Re-entrancy guard so overlapping claim triggers coalesce into one loop. */
  private claiming = false;
  private claimAgain = false;
  /** The claim pass in progress — `shutdown()` lets it finish before it
   *  snapshots the active runs, so a row claimed mid-shutdown is not missed. */
  private claimInFlight: Promise<void> | undefined;
  private nudgeScheduled = false;

  private staleTimer: ReturnType<typeof setInterval> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private nudgeTimer: ReturnType<typeof setTimeout> | undefined;
  private retentionTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * V3-1 — runs `fn` in the async context this executor was constructed in
   * (composition time, `packages/wiring/src/build-agent-loop.ts`), not the
   * context of whoever triggered the claim. `nudge()` is called from inside a
   * tool call; without this, the claim loop and every job it started while
   * that call's batch was open inherited the batch's run-taint link
   * (packages/core/src/scoped/run-taint.ts) — so a job of an unrelated session
   * started with the downgrade armed and was recorded tainted, and its own
   * untrusted read tainted the unrelated run that nudged. A job's taint rides
   * `markTainted` / `BackgroundJob.tainted` instead. Pinned by
   * `__tests__/taint-isolation.test.ts`.
   */
  private readonly detached = AsyncResource.bind(<T>(fn: () => T): T => fn());

  constructor(deps: BackgroundExecutorDeps) {
    this.store = deps.store;
    this.defaultRunner = new EthosJobRunner(deps.loop);
    this.runners = deps.runners;
    this.owner = deps.owner;
    this.resumeAffinity = deps.resumeAffinity;
    this.releasedAs = deps.affinity !== undefined ? `released:${deps.affinity}` : undefined;
    this.config = deps.config;
    this.pollMs = deps.config.pollMs ?? DEFAULT_POLL_MS;
    this.log = deps.log;
    this.digests = new RunDigestBoard(this.defaultRunner.name, deps.log);
    this.hooks = deps.hooks;
    this.cancelInteractions = deps.cancelInteractions;
  }

  /**
   * Register a completion handler, fired after every terminal transition of a
   * job (`done` / `failed` / `aborted`, including the stale→terminal recovered
   * case) with the final persisted job row. The subscriber decides suppression
   * (e.g. stay silent on `aborted`). Returns an unsubscribe function.
   */
  onComplete(handler: (job: BackgroundJob) => void): () => void {
    this.completeHandlers.push(handler);
    return () => {
      const idx = this.completeHandlers.indexOf(handler);
      if (idx !== -1) this.completeHandlers.splice(idx, 1);
    };
  }

  /**
   * Subscribe to the coalesced run digest (G9/D11/D20). Fires at most once per
   * `RUN_UPDATE_MIN_INTERVAL_MS` per run, plus immediately on every status
   * change — a status is the one thing that must never wait out a coalescing
   * window. Returns an unsubscribe function.
   *
   * The executor publishes a routing key (`parentSessionKey`) and facts; it does
   * NOT know what a session stream is. The surface that owns one — web-api's
   * SSE layer — resolves the key to its own session and maps the digest onto
   * its `run.update` push event.
   */
  onRunUpdate(handler: (update: RunUpdateDigest) => void): () => void {
    return this.digests.subscribe(handler);
  }

  /** Number of jobs currently running in the pool. */
  activeCount(): number {
    return this.activeControllers.size;
  }

  /**
   * Park a run on a human answer: `running` -> `blocked`, and pause its
   * heartbeat. THE SEAM for whatever asks the question — a runner's gate
   * escalating through the clarify bridge, or a child turn's own `clarify` call.
   * The executor deliberately does not know which; it only owns the state.
   *
   * Cancellation is NOT paused with the beat: the blocked card offers Cancel, so
   * the timer keeps observing `cancelRequested` and can still abort the run.
   *
   * Ignored for a job this executor is not running — another process owns that
   * row's beat, and tracking it here would leak a pause that nothing clears.
   */
  async markJobBlocked(jobId: string, requestId: string): Promise<void> {
    const run = this.activeControllers.get(jobId);
    if (!run) return;
    this.blockedJobs.set(jobId, requestId);
    // Fenced: a run that lost its row must not park the claim that took it.
    await this.store.markBlocked(jobId, requestId, this.activeFences.get(jobId));
    // Empty `now`: "paused — waiting on you" is UI copy and lives in the copy
    // module, not here. The status is the fact; the phrasing is the surface's.
    this.digests.update(jobId, { status: 'blocked', now: '' }, run);
  }

  /** The counterpart: `blocked` -> `running`, and the heartbeat resumes. */
  async resumeJob(jobId: string): Promise<void> {
    if (!this.blockedJobs.delete(jobId)) return;
    await this.store.resumeFromBlocked(jobId, this.activeFences.get(jobId));
    const run = this.activeControllers.get(jobId);
    if (run) this.digests.update(jobId, { status: 'running' }, run);
  }

  /**
   * Run the boot sweep ONCE, then start the periodic stale sweep and the backstop
   * claim poll. Idempotent — a second call is a no-op.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    void this.bootSweep();

    // Stale/expiry sweep cadence is the heartbeat interval (a running peer beats
    // every heartbeatMs); the staleMs THRESHOLD is separate. See sweep().
    this.staleTimer = setInterval(() => void this.sweep(), this.config.heartbeatMs);
    this.staleTimer.unref?.();

    this.pollTimer = setInterval(() => void this.claimLoop(), this.pollMs);
    this.pollTimer.unref?.();

    // Retention GC — prune terminal rows older than the retention window. One
    // prune at boot, then a slow (hourly) timer. Disabled when retentionMs <= 0.
    const retentionMs = this.config.retentionMs ?? 0;
    if (retentionMs > 0) {
      void this.pruneRetention(retentionMs);
      this.retentionTimer = setInterval(() => void this.pruneRetention(retentionMs), 3_600_000);
      this.retentionTimer.unref?.();
    }
  }

  /**
   * F06 — retire this executor WITHOUT aborting anything, for a loop that has
   * been REPLACED while its process lives on (the chat `/model` switch): claim
   * nothing more, hand queued rows on to the successor (`affinity`) — now and
   * on every later poll, so a row a running job spawns is not stranded behind
   * it — and resolve once every running job has finished on its own. The
   * caller disposes the loop afterwards (`shutdown()` then finds nothing to
   * abort). A process stop uses `shutdown()` directly and does not wait.
   * Pinned by `__tests__/executor.test.ts`.
   */
  async drain(): Promise<void> {
    this.draining = true;
    await this.claimInFlight;
    await this.releaseQueuedRows();
    while (this.activeRuns.size > 0) {
      await Promise.allSettled([...this.activeRuns.values()]);
    }
  }

  private async releaseQueuedRows(): Promise<void> {
    if (!this.releasedAs || !this.store.releaseQueued) return;
    try {
      const moved = await this.store.releaseQueued(this.owner, this.releasedAs);
      if (moved > 0) this.log?.(`handed ${moved} queued job(s) back as ${this.releasedAs}`);
    } catch (err) {
      this.log?.(`releaseQueued failed: ${errMsg(err)}`);
    }
  }

  /** Delete terminal rows older than the retention window. Never crashes the executor. */
  private async pruneRetention(retentionMs: number): Promise<void> {
    try {
      const deleted = await this.store.pruneTerminal(Date.now() - retentionMs);
      if (deleted > 0) this.log?.(`retention GC pruned ${deleted} terminal job(s)`);
    } catch (err) {
      this.log?.(`retention prune failed: ${errMsg(err)}`);
    }
  }

  /**
   * Trigger an immediate claim attempt. Coalesced onto the next tick so a burst
   * of nudges (one per queued row) collapses into a single claim loop.
   */
  nudge(): void {
    if (this.shuttingDown || this.nudgeScheduled) return;
    this.nudgeScheduled = true;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeScheduled = false;
      void this.claimLoop();
    }, 0);
    this.nudgeTimer.unref?.();
  }

  /**
   * Run the observe pass for `jobId` now, when THIS executor owns the run, so
   * an in-process requester's steer or stop lands without waiting for the next
   * `JOB_OBSERVE_MS` tick. A job another process owns is a no-op here: its
   * owner's tick picks the row up. Never throws.
   */
  pokeSteer(jobId: string): void {
    const observe = this.observers.get(jobId);
    if (observe) void observe();
  }

  /**
   * Graceful drain: stop timers, hand the queued rows on (`affinity`), abort
   * every active job's controller, and wait for the in-flight runs to unwind.
   * A RESUMABLE run (`resumeOnRestart`, a stable affinity, a runner with
   * `autoResume`, not `noResume`, under `maxResumes`) is requeued for its
   * successor instead of ended — pinned by `__tests__/durable-resume.test.ts`.
   * Every other aborted run finishes itself as ('aborted',
   * `JOB_ABORTED_BY_SHUTDOWN`) via the shutdown terminal branch in runOne —
   * so shutdown does NOT call store.finish itself (a second finish on an
   * already-terminal row throws; runOne stays the single owner of a run's last
   * transition).
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.started = false;
    if (this.staleTimer) clearInterval(this.staleTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.staleTimer = undefined;
    this.pollTimer = undefined;
    this.nudgeTimer = undefined;
    this.retentionTimer = undefined;

    // No claim pass may still be starting a run once the snapshot below is taken.
    await this.claimInFlight;

    // F06 — the queued rows this executor will now never start go to its
    // successor (same `affinity`) instead of waiting out `expireQueued`.
    await this.releaseQueuedRows();

    const runs = [...this.activeRuns.values()];
    for (const controller of this.activeControllers.values()) controller.abort();
    await Promise.allSettled(runs);

    // Each run's own teardown drops its digest; anything left here belongs to a
    // run that never unwound, and its trailing timer must not outlive us.
    this.digests.clear();
  }

  // -------------------------------------------------------------------------
  // Boot + periodic sweeps
  // -------------------------------------------------------------------------

  /**
   * Boot sweep (runs once at start). Uses the CONFIGURED staleMs threshold, NOT
   * reclaimStale(0). Rationale: under `run-all`, gateway + serve are separate
   * processes sharing one jobs.db with DIFFERENT owners. A 0-threshold sweep
   * would clobber a LIVE peer's running rows. The 90s staleMs threshold protects
   * a live peer (its heartbeats are <30s old) while still catching genuinely
   * orphaned rows (heartbeat aged past 90s) — here and on every periodic sweep.
   *
   * PUBLIC (not private) because boot/resume reconciliation invokes it
   * directly: `runBootReconciliation` (apps/ethos/src/boot-reconciliation.ts)
   * composes it with the other boot-time repair steps, and a resume handler
   * re-runs that composition without re-running `start()`.
   */
  async bootSweep(): Promise<void> {
    try {
      await this.store.reclaimStale(this.config.staleMs, { maxResumes: this.autoResumeMax });
    } catch (err) {
      this.log?.(`boot reclaimStale failed: ${errMsg(err)}`);
    }
    try {
      await this.store.expireQueued(this.config.queuedTtlMs, { resumeTtlMs: this.resumeTtlMs });
    } catch (err) {
      this.log?.(`boot expireQueued failed: ${errMsg(err)}`);
    }
    await this.claimLoop();
  }

  /**
   * The `maxResumes` a sweep passes: 0 (never requeue) when auto-resume is off.
   * Deliberately not gated on this executor's own `resumeAffinity`: a
   * non-resumable process (`ethos chat`, desktop) sweeping a crashed serve job
   * must requeue it for serve (the row's stamped `resume_affinity` decides who
   * adopts), not stale it for good. Pinned by `__tests__/durable-resume.test.ts`.
   */
  private get autoResumeMax(): number {
    return this.config.resumeOnRestart === true
      ? (this.config.maxResumes ?? DEFAULT_MAX_RESUMES)
      : 0;
  }

  private get resumeTtlMs(): number {
    return this.config.resumeTtlMs ?? DEFAULT_RESUME_TTL_MS;
  }

  /**
   * Manual Resume seam (`JobControl.resume`): a `stale` row goes back to
   * `queued` under this executor's label and is claimed on the next nudge. Not
   * counted against `maxResumes`. False when the row is not `stale` (or the store
   * cannot requeue).
   */
  async requeueStale(jobId: string): Promise<boolean> {
    const ok = (await this.store.requeueStale?.(jobId, this.releasedAs ?? this.owner)) ?? false;
    if (ok) this.nudge();
    return ok;
  }

  private async sweep(): Promise<void> {
    try {
      await this.store.reclaimStale(this.config.staleMs, { maxResumes: this.autoResumeMax });
    } catch (err) {
      this.log?.(`reclaimStale failed: ${errMsg(err)}`);
    }
    try {
      await this.store.expireQueued(this.config.queuedTtlMs, { resumeTtlMs: this.resumeTtlMs });
    } catch (err) {
      this.log?.(`expireQueued failed: ${errMsg(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Claim / pool loop
  // -------------------------------------------------------------------------

  /**
   * Claim queued rows until the pool is full or nothing is queued. Serialized by
   * `claiming` so concurrent triggers (nudge, poll, a finishing job) never
   * stampede; `claimAgain` re-runs the loop once if a trigger arrived mid-claim
   * (e.g. a row queued after we last saw the queue empty).
   */
  private claimLoop(): Promise<void> {
    // Every claim trigger — nudge, poll, boot sweep, a finishing job — enters
    // here, and every job starts inside `claimRows`, so this one detach covers
    // them all, `fireComplete` included.
    return this.detached(() => this.runClaimLoop());
  }

  private async runClaimLoop(): Promise<void> {
    if (this.claiming) {
      this.claimAgain = true;
      return;
    }
    this.claiming = true;
    const pass = this.claimRows();
    this.claimInFlight = pass;
    try {
      await pass;
    } finally {
      this.claiming = false;
      this.claimInFlight = undefined;
    }
  }

  private async claimRows(): Promise<void> {
    // Draining: this executor starts nothing more; whatever was queued since
    // the last pass goes to its successor instead.
    if (this.draining) {
      await this.releaseQueuedRows();
      return;
    }
    do {
      this.claimAgain = false;
      while (
        !this.shuttingDown &&
        !this.draining &&
        this.activeControllers.size < this.config.maxConcurrentJobs
      ) {
        let job: BackgroundJob | null;
        try {
          job = this.releasedAs
            ? await this.store.claimNextQueued(this.owner, { adopt: this.releasedAs })
            : await this.store.claimNextQueued(this.owner);
        } catch (err) {
          this.log?.(`claimNextQueued failed: ${errMsg(err)}`);
          break;
        }
        if (!job) break;
        this.startRun(job);
      }
    } while (this.claimAgain && !this.shuttingDown);
  }

  /** Register the job's controller synchronously, then run it detached. */
  private startRun(job: BackgroundJob): void {
    const controller = new AbortController();
    // One listener covers every abort reason — cancel, spend cap, shutdown
    // drain — instead of a call at each `controller.abort()` site, where the
    // next reason added would silently miss it.
    controller.signal.addEventListener(
      'abort',
      () => {
        if (controller.signal.reason === OWNERSHIP_LOST) return;
        void this.cancelInteractions?.(job.id).catch((err) => {
          this.log?.(`cancelling pending questions failed for ${job.id}: ${errMsg(err)}`);
        });
      },
      { once: true },
    );
    this.activeControllers.set(job.id, controller);
    const fence = fenceOf(job);
    if (fence) this.activeFences.set(job.id, fence);
    const run = this.runOne(job, controller, fence).finally(() => {
      // A sweep can requeue a live row and this executor re-adopt it while this
      // run is still unwinding; then the maps hold the NEW run's entries and
      // none of them are ours to delete. Pinned by
      // `__tests__/durable-resume-review.test.ts` ('an old run settling does not
      // untrack its successor').
      if (this.activeControllers.get(job.id) === controller) {
        this.activeControllers.delete(job.id);
        this.activeFences.delete(job.id);
        if (this.activeRuns.get(job.id) === run) this.activeRuns.delete(job.id);
        // A run that ended while parked (cancelled from the blocked card) must not
        // leave its pause behind.
        this.blockedJobs.delete(job.id);
        // Belt and braces: `finishAndNotify` closes the digest on every path it
        // owns, but a throw between openDigest and the finish would strand a
        // timer.
        this.digests.dropOwnedBy(job.id, controller);
      }
      // A slot freed — pull the next queued row (unless we're draining).
      if (!this.shuttingDown) void this.claimLoop();
    });
    this.activeRuns.set(job.id, run);
  }

  // -------------------------------------------------------------------------
  // Running one job
  // -------------------------------------------------------------------------

  /**
   * Which runner executes this row. A row carries the runner it was spawned
   * for; an unset (or default-named) row runs on the default runner. A row
   * naming a runner this process has not resolved throws — the caller sees a
   * failed job with the reason, never a silent fallback onto Ethos, which would
   * run a task on a harness the requester deliberately did not choose.
   */
  private runnerFor(job: BackgroundJob): JobRunner {
    const name = job.runner;
    if (!name || name === this.defaultRunner.name) return this.defaultRunner;
    const runner = this.runners?.get(name);
    if (!runner) throw new Error(`job runner '${name}' is not available in this process`);
    return runner;
  }

  private async runOne(
    job: BackgroundJob,
    controller: AbortController,
    fence: JobClaimFence | undefined,
  ): Promise<void> {
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let observeTimer: ReturnType<typeof setInterval> | undefined;
    let ownObserve: (() => Promise<void>) | undefined;
    // `fence` is this claim's identity: every terminal and spend write is fenced
    // on it, so a run that lost its row cannot write over the claim that took it.
    // Set by the observe pass when the row was requeued or claimed away under this
    // run. From then on this run writes nothing to the row: no beat, no read marks,
    // no events (`__tests__/durable-resume-review.test.ts`, 'a lost run goes quiet').
    let lost = false;
    const skipIfLost = (): boolean => {
      if (lost) this.log?.(`run lost ownership of ${job.id}; not finishing`);
      return lost;
    };
    const stopBeat = (): void => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    };
    const stopTimers = (): void => {
      stopBeat();
      if (observeTimer) clearInterval(observeTimer);
      observeTimer = undefined;
      if (ownObserve && this.observers.get(job.id) === ownObserve) this.observers.delete(job.id);
    };
    // The durable steer queue's in-memory face (D1). `markReadChain` keeps the
    // `pending -> read` writes in drain order.
    const steerSink = createJobSteerSink();
    let markReadChain: Promise<void> = Promise.resolve();
    const markDrained = (): void => {
      if (lost) return;
      const ids = steerSink.takeDrainedIds();
      const mark = this.store.markSteersRead?.bind(this.store);
      if (ids.length === 0 || !mark) return;
      markReadChain = markReadChain
        .then(() => mark(job.id, ids))
        .catch((err) => this.log?.(`markSteersRead failed for ${job.id}: ${errMsg(err)}`));
    };
    // D3 ordering: every terminal write goes through `finish`, and `finish`
    // settles the read marks first. `store.finish` sweeps `pending -> unread`
    // in its own transaction, so a drained-but-unmarked steer would otherwise
    // be reported unread although the model read it.
    // V2-SEC-2 — set by the runner's `markTainted`; every terminal write carries it.
    // Seeded from the row: a resumed run that already read untrusted content stays tainted.
    const tainted = { value: job.tainted === true };
    // Resolved after `runnerFor` below; the shutdown branches read it.
    let resumable = false;
    // D4 — a graceful stop requeues the run for its successor instead of ending it.
    // Same read-mark ordering as `finish`: settle the drained steers first.
    const trySuspend = async (): Promise<boolean> => {
      markDrained();
      await markReadChain;
      return this.suspendForResume(job.id);
    };
    const finish = (
      terminal: 'done' | 'failed' | 'aborted',
      fields: { summary?: string; error?: string },
    ): Promise<void> =>
      (async () => {
        markDrained();
        await markReadChain;
        await this.finishAndNotify(
          job.id,
          terminal,
          tainted.value ? { ...fields, tainted: true } : fields,
          fence,
        );
      })();
    try {
      // Pre-start aggregate spend gate. Sum spend across the root's jobs;
      // refuse to run if the cap is already reached.
      const cap = this.config.maxRootBackgroundUsd;
      if (cap !== null) {
        // Includes this job: a resumed run carries its earlier spend (D11); a
        // first run's own spend is 0, so nothing changes there.
        const siblings = await this.store.listByRoot(job.rootSessionKey);
        const sum = siblings.reduce((acc, j) => acc + (j.spendUsd ?? 0), 0);
        if (sum >= cap) {
          await finish('failed', {
            error: `root background spend cap $${cap} reached (already spent $${sum})`,
          });
          return;
        }
      }

      // Per-job heartbeat: the beat only. Cancel and steers ride the observe tick.
      let cancelled = false;
      heartbeatTimer = setInterval(() => {
        void (async () => {
          try {
            // Paused while the run is parked on a human answer — see
            // markJobBlocked.
            if (!this.blockedJobs.has(job.id)) await this.store.heartbeat(job.id);
          } catch (err) {
            this.log?.(`heartbeat failed for ${job.id}: ${errMsg(err)}`);
          }
        })();
      }, this.config.heartbeatMs);
      heartbeatTimer.unref?.();

      // A steer sent while the job was queued is read at its first seam (D6).
      const pull = async (afterId: number): Promise<JobSteer[]> =>
        (await this.store.listPendingSteers?.(job.id, afterId)) ?? [];
      steerSink.enqueue(await pull(0));
      // Observe pass (D7): the cancel flag — also while blocked, so a parked run
      // stays cancellable — then steers newer than the sink has seen, then the
      // marks for whatever the harness drained since the last pass.
      // Single-flight: the interval and `pokeSteer` can overlap, so a trigger
      // during a pass is folded into one more pass after it.
      let observing: Promise<void> | undefined;
      let again = false;
      const observePass = async (): Promise<void> => {
        try {
          const fresh = await this.store.get(job.id);
          // Ownership loss, whatever the row's status now: it went back to
          // `queued`, or another claim took it (a different owner or startedAt —
          // also when that claim is already blocked or terminal), under this
          // live run (a late heartbeat swept by a peer, D13). Pinned by
          // `__tests__/durable-resume-review.test.ts` ('a claim that moved on').
          // `stale` with the same owner and startedAt is NOT lost — that path still
          // ends in `recovered`.
          if (
            fresh &&
            !lost &&
            (fresh.status === 'queued' ||
              fresh.owner !== this.owner ||
              fresh.startedAt !== job.startedAt)
          ) {
            lost = true;
            stopBeat();
            controller.abort(OWNERSHIP_LOST);
          }
          if (lost) return;
          if (fresh?.cancelRequested && !cancelled) {
            cancelled = true;
            controller.abort();
          }
          steerSink.enqueue(await pull(steerSink.lastSeenId));
          markDrained();
        } catch (err) {
          this.log?.(`observe failed for ${job.id}: ${errMsg(err)}`);
        }
      };
      const observe = (): Promise<void> => {
        if (observing) {
          again = true;
          return observing;
        }
        observing = (async () => {
          do {
            again = false;
            await observePass();
          } while (again);
          observing = undefined;
        })();
        return observing;
      };
      ownObserve = observe;
      this.observers.set(job.id, observe);
      observeTimer = setInterval(() => void observe(), JOB_OBSERVE_MS);
      observeTimer.unref?.();

      const runner = this.runnerFor(job);

      // D2/D6 — stamp the row resumable only when every condition holds; stamped
      // on every claim so a switch turned off since the last one takes effect.
      resumable =
        this.config.resumeOnRestart === true &&
        this.resumeAffinity !== undefined &&
        runner.capabilities.autoResume === true &&
        job.noResume !== true &&
        this.store.requeueForResume !== undefined;
      if (resumable || job.resumeAffinity !== undefined) {
        try {
          await this.store.setResumeAffinity?.(
            job.id,
            resumable ? (this.resumeAffinity ?? null) : null,
          );
        } catch (err) {
          this.log?.(`setResumeAffinity failed for ${job.id}: ${errMsg(err)}`);
        }
      }

      // An unreadable trail still resumes (continuation prompt, not the original
      // task prompt): `resumeContextFor` falls back to an empty trail.
      let resume: JobRunnerContext['resume'];
      if (job.requeuedAt !== undefined) {
        let trail: BackgroundJobEvent[] = [];
        try {
          trail = await this.store.getEvents(job.id, { eventType: 'requeued', limit: 1 });
        } catch (err) {
          this.log?.(`reading the resume trail failed for ${job.id}: ${errMsg(err)}`);
        }
        resume = resumeContextFor(job, trail);
      }

      // G9/D11 — from here the card is fed by the digest and nothing else. Open
      // it AFTER the spend gate above, which can end the run before it starts.
      this.digests.open(job, controller);

      let output = '';
      // D11 — a resumed run starts from the spend it already carries.
      let spend = job.spendUsd ?? 0;
      let errorText: string | undefined;
      let costBreached = false;
      let turnDone = false;

      const text = createTextSink(this.store, job.id, this.log);
      const logSink = createLogSink(this.store, job.id, this.log);

      for await (const ev of runner.run(job, {
        signal: controller.signal,
        steerSink,
        ...(resume ? { resume } : {}),
        // Artifacts are a job-event-log concern, not an event-stream one:
        // `AgentEvent` is frozen at 17 variants with no artifact slot, so a
        // file change becomes an `artifact_change` ROW and the inspector's Diff
        // tab reads it back from there. `emitArtifact` is synchronous by
        // contract — a runner does not await the audit trail — so the write is
        // fire-and-forget with the same swallow-and-log policy as every other
        // appendEvent here: losing an audit row must never fail the job it
        // describes.
        emitArtifact: (change: ArtifactChange) => {
          if (lost) return;
          void this.store
            .appendEvent(job.id, 'artifact_change', {
              ...change,
              ...(change.diff !== undefined
                ? { diff: capText(change.diff, ARTIFACT_DIFF_CAP) }
                : {}),
            })
            .catch((err) =>
              this.log?.(`appendEvent(artifact_change) failed for ${job.id}: ${errMsg(err)}`),
            );
        },
        // I-LOG1 — same out-of-band, synchronous-by-contract shape as
        // `emitArtifact` above, batched by `createLogSink` into bounded
        // `runner_log` rows instead of one write per line.
        appendLog: (stream, line) => {
          if (!lost) logSink.appendLog(stream, line);
        },
        // V2-SEC-2 — recorded with the terminal transition (`finishAndNotify`).
        // D12 — also written to the row now, so a crash after the read still
        // leaves a tainted row for the resumed run and a parent-review turn.
        markTainted: () => {
          if (tainted.value) return;
          tainted.value = true;
          void Promise.resolve(this.store.markTainted?.(job.id)).catch((err) =>
            this.log?.(`markTainted failed for ${job.id}: ${errMsg(err)}`),
          );
        },
      })) {
        // Cancel, cost cap, shutdown: stop here rather than drain (contrast
        // `done` below). Past an abort AgentLoop starts no new tool work —
        // agent-loop.ts re-checks the signal after each streamed step,
        // `processTools` (agent-loop/stages/tool-processing.ts) refuses each
        // call before its `before_tool_call` hooks (`rejectAbortedCall`), and
        // `executeParallel` refuses before each dispatch — but a hook already
        // parked when the abort lands (an approval waiting on a human) runs to
        // its end first, and draining would wait on it for a job that was just
        // told to stop.
        if (controller.signal.aborted) break;

        if (ev.type === 'text_delta') {
          output += ev.text;
          await text.push(ev.text);
        } else if (ev.type === 'thinking_delta') {
          // Ignore — thinking is not persisted to the job's output.
        } else if (ev.type === 'tool_start') {
          // Flush first so the stream's order matches the run's order: the text
          // that led to a tool call reads before the call, not after it.
          await text.flush();
          try {
            await this.store.appendEvent(job.id, 'tool_headline', {
              toolName: ev.toolName,
              arg: shortArgDigest(ev.args),
            });
          } catch (err) {
            this.log?.(`appendEvent failed for ${job.id}: ${errMsg(err)}`);
          }
          this.digests.update(job.id, { now: nowLine(ev.toolName, ev.args) }, controller);
        } else if (ev.type === 'tool_end') {
          this.digests.update(
            job.id,
            { toolCount: this.digests.toolCount(job.id) + 1 },
            controller,
          );
          try {
            await this.store.appendEvent(job.id, 'tool_end', {
              toolName: ev.toolName,
              ok: ev.ok,
              durationMs: ev.durationMs,
              // `error` is set only when ok is false (AgentEvent contract).
              ...(ev.error !== undefined ? { error: shortArgDigest(ev.error) } : {}),
            });
          } catch (err) {
            this.log?.(`appendEvent failed for ${job.id}: ${errMsg(err)}`);
          }
        } else if (ev.type === 'usage') {
          spend += ev.estimatedCostUsd ?? 0;
          try {
            await this.store.updateSpend(job.id, spend, fence);
          } catch (err) {
            this.log?.(`updateSpend failed for ${job.id}: ${errMsg(err)}`);
          }
          this.digests.update(job.id, { spendUsd: spend }, controller);
          if (job.maxCostUsd != null && spend > job.maxCostUsd) {
            costBreached = true;
            controller.abort();
          }
        } else if (ev.type === 'error') {
          errorText = ev.error;
        } else if (ev.type === 'done') {
          // NOT `break`: the default runner hands back `AgentLoop.run()`, which
          // yields `done` BEFORE its turn-end work (`maybeConsolidateAtTurnEnd`
          // — the context engine's `onTurnComplete`, the memory flush,
          // auto-compaction), and closing the generator skips it (F07). The
          // iterator is drained; the job holds its slot until it ends. Pinned by
          // `__tests__/turn-tail.test.ts`.
          turnDone = true;
          // A `returnDirect` tool result arrives only as `done.text`, after any
          // preamble that streamed: `answerSuffix` (@ethosagent/types) is what
          // the stream still owes the job's output.
          const owed = answerSuffix(output, ev.text);
          if (owed) {
            output += owed;
            await text.push(owed);
          }
        }
        // Forward-compat: any other event type is a no-op.
      }

      stopTimers();
      if (skipIfLost()) return;

      // Whatever the terminal state, the tail of the child's text belongs in the
      // stream before the terminal event.
      await text.flush();
      // Same for whatever runner-log lines are still buffered. Known gap,
      // matching `stderrTail`'s existing crash tradeoff: a throw between here
      // and process exit — or a crash mid-buffer before this point — loses
      // whatever hasn't flushed yet. No crash-durability is built for this.
      await logSink.flush();

      // A turn that yielded `done` with no `error` before it has its answer.
      // A cancel or shutdown that lands while its turn-end tail drains (above)
      // does not un-finish it — the answer is already complete, and calling it
      // aborted would throw it away. The shutdown case is pinned by
      // `__tests__/turn-tail.test.ts`; a cancel takes the same branch.
      const answered = turnDone && !errorText;

      // Terminal transition, in priority order.
      if (costBreached) {
        await finish('failed', {
          error: `exceeded max_cost_usd $${job.maxCostUsd} (spent $${spend.toFixed(4)})`,
        });
      } else if (cancelled && !answered) {
        // D9: the partial output is kept, bounded like a `done` summary.
        await finish('aborted', {
          error: 'cancelled by task_cancel',
          ...(output
            ? { summary: capText(extractSummarySection(output) ?? output, SUMMARY_RESULT_CAP) }
            : {}),
        });
      } else if (this.shuttingDown && !answered) {
        // A resumable run is requeued (the cap lives in the store's SQL); at the
        // cap, or when the store refuses, it ends as before.
        if (resumable && (await trySuspend())) return;
        await finish('aborted', { error: JOB_ABORTED_BY_SHUTDOWN });
      } else if (errorText) {
        await finish('failed', { error: errorText });
      } else {
        const summary = extractSummarySection(output) ?? output;
        await finish('done', {
          summary: capText(summary, SUMMARY_RESULT_CAP),
        });
      }
    } catch (err) {
      stopTimers();
      if (skipIfLost()) return;
      // A thrown error fails the job — unless we're draining, where an abort is
      // the honest terminal state (or a requeue, for a resumable run).
      try {
        if (this.shuttingDown) {
          if (resumable && (await trySuspend())) return;
          await finish('aborted', { error: JOB_ABORTED_BY_SHUTDOWN });
        } else {
          await finish('failed', { error: errMsg(err) });
        }
      } catch (finishErr) {
        this.log?.(`finish failed for ${job.id}: ${errMsg(finishErr)}`);
      }
    }
  }

  /**
   * `running|blocked -> queued` for the successor (D4). True when the store
   * requeued the row; the card then closes as `queued` and no completion fires.
   */
  private async suspendForResume(jobId: string): Promise<boolean> {
    try {
      const ok = await this.store.requeueForResume?.(jobId, {
        reason: 'restart',
        maxResumes: this.config.maxResumes ?? DEFAULT_MAX_RESUMES,
      });
      if (ok !== true) return false;
      this.digests.close(jobId, 'queued');
      return true;
    } catch (err) {
      this.log?.(`requeueForResume failed for ${jobId}: ${errMsg(err)}`);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Terminal transition + completion notification
  // -------------------------------------------------------------------------

  /**
   * Single owner of the terminal transition: writes the finish, then fetches the
   * fresh persisted row and notifies subscribers (onComplete handlers + the
   * optional `on_background_job_complete` void hook). Notification runs only
   * after `store.finish` succeeds. Fires for ALL terminal states — including
   * `aborted` — so the subscriber, not the executor, decides suppression.
   */
  private async finishAndNotify(
    id: string,
    terminal: 'done' | 'failed' | 'aborted',
    fields: { summary?: string; error?: string; tainted?: boolean },
    fence?: JobClaimFence,
  ): Promise<void> {
    try {
      await this.store.finish(id, terminal, fields, fence);
    } catch (err) {
      // A fenced refusal means another claim holds the row: no completion fires.
      if (isClaimLostError(err)) {
        this.log?.(`finish for ${id} refused: the row is held by another claim`);
        return;
      }
      throw err;
    }
    // The card's last sample. Published before the completion notice so the run
    // card is already terminal when Ethos's hand-back message lands under it.
    this.digests.close(id, terminal);
    const fresh = await this.store.get(id);
    if (!fresh) return;
    this.fireComplete(fresh);
    if (this.hooks) {
      try {
        await this.hooks.fireVoid('on_background_job_complete', { job: fresh });
      } catch (err) {
        this.log?.(`on_background_job_complete hook failed for ${id}: ${errMsg(err)}`);
      }
    }
  }

  /** Invoke every onComplete subscriber. A subscriber throwing never crashes the executor. */
  private fireComplete(job: BackgroundJob): void {
    for (const handler of [...this.completeHandlers]) {
      try {
        handler(job);
      } catch (err) {
        this.log?.(`onComplete handler failed for ${job.id}: ${errMsg(err)}`);
      }
    }
  }
}
