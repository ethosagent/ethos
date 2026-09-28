import { randomUUID } from 'node:crypto';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { LocalExecutionBackend } from '@ethosagent/execution-local';
import { noopLogger } from '@ethosagent/logger';
import { sanitize, wrapUntrusted } from '@ethosagent/safety-injection';
import { redactString } from '@ethosagent/safety-redact';
import type {
  ExecutionBackend,
  Logger,
  SecretsResolver,
  Storage,
  TurnAudience,
} from '@ethosagent/types';
import { decideEscalation, type HeartbeatAction } from './heartbeat';
import { currentBootId, isPidAlive, withJobsFileLock } from './jobs-lock';
import {
  type CronRunProgress,
  PROGRESS_SUFFIX,
  parseRunProgress,
  progressPathFor,
} from './progress';
import { isOneShotSchedule, isValidSchedule, nextRunForSchedule } from './schedule';

export {
  CronProgressRecorder,
  type CronRunProgress,
  formatRunProgress,
  PROGRESS_ELISION_TOOL,
  PROGRESS_HEAD_LIMIT,
  PROGRESS_MESSAGE_MAX_CHARS,
  PROGRESS_SUFFIX,
  PROGRESS_TAIL_LIMIT,
  parseRunProgress,
  progressPathFor,
} from './progress';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MissedRunPolicy = 'run-once' | 'skip';
export type JobStatus = 'active' | 'paused' | 'done';

export interface RepeatPolicy {
  kind: 'forever' | 'once' | 'count';
  /** Required when kind === 'count'. */
  maxRuns?: number;
}

/** Origin channel captured at create time; absent means file-only delivery. */
export interface JobOrigin {
  platform: string;
  chatId: string;
  /**
   * The bot the job was created through (segment 1 of the gateway lane key,
   * captured by `extractOrigin` in `@ethosagent/tools-cron`). Delivery goes
   * through THIS bot (`createCronDeliver`, apps/ethos/src/lib/cron-deliver.ts),
   * never the platform's first adapter. Absent on jobs created before it was
   * recorded: those deliver only when the platform has exactly one bot.
   */
  botKey?: string;
  /**
   * The thread or forum topic the job was created in (UBP-024), captured by
   * `extractOrigin` in `@ethosagent/tools-cron` from the gateway's live turn.
   * Delivery returns there (`createCronDeliver` passes it to
   * `Gateway.notifyTracked`). Absent → the chat root.
   */
  threadId?: string;
}

/**
 * Reference to an operator-authored script under the scripts directory
 * (`<state dir>/scripts/`, `~/.ethos/scripts/` by default). `file` is relative to that directory —
 * absolute paths and `..` traversal are rejected at create AND run time.
 * The interpreter is fixed by extension (`.sh` → bash, `.py` → python3);
 * shebangs are deliberately not honored. The file must already exist at
 * create time — an agent cannot write-then-schedule its own script.
 */
export interface ScriptRef {
  /** Path relative to the scripts directory. Only .sh and .py are allowed. */
  file: string;
  /** Wall-clock limit in seconds. Default 60, max 600. */
  timeoutSeconds?: number;
}

export interface CronJob {
  id: string;
  name: string;
  /** Schedule expression: 5-field cron, relative delay (30m), interval (every 2h), or ISO timestamp. */
  schedule: string;
  /** Prompt the agent will run. Optional for source:'system' jobs (they use systemTask handlers). */
  prompt?: string;
  /** Script-mode job: the script IS the job, zero LLM involvement.
   *  Mutually exclusive with `prompt`; not allowed on source:'system' jobs.
   *  Semantics: exit 0 + non-empty stdout → stdout delivered verbatim;
   *  exit 0 + empty stdout → silent tick (audited as 'script-silent');
   *  non-zero exit / timeout → lastError + a delivered failure notice. */
  script?: ScriptRef;
  /** Precheck gate on prompt jobs: runs before the LLM turn. Exit 0 →
   *  run the turn with stdout prepended as sanitized untrusted context;
   *  exit 78 → skip the turn entirely (zero LLM calls, audited as
   *  'precheck-skip'); any other exit / timeout → fail-open (turn runs
   *  without the context). Only allowed on user prompt jobs. */
  precheck?: ScriptRef;
  personalityId: string;
  /** Channel origin captured at create time; absent means file-only. */
  origin?: JobOrigin;
  /**
   * The room audience of whatever created the job (plan
   * personality-memory-boundary G1-6): the creating turn's resolved
   * `ToolContext.roomAudience` (`cron` tool), or the web Cron page's delivery
   * target (`CronService.create`, apps/web-api). Top-level, not on `JobOrigin`:
   * a CLI-created job has no origin but still has an audience. Absent on jobs
   * written before the field existed. Never restamped after creation: a
   * shared turn cannot see, edit or run a job not stamped `'shared'`
   * (`readableFrom` in extensions/tools-cron/src/index.ts, pinned by its
   * `__tests__/room-audience.test.ts`). Read here only by `resolveContext`'s fire-time check (through
   * `CronSchedulerConfig.runAudience`, or `stampAudience` when a host passes
   * none) — the runners resolve a firing's audience with
   * `cronRunAudience` (packages/wiring/src/cron-audience.ts), which also judges
   * the delivery target and `contextFrom`, and judges an absent stamp by the
   * delivery target alone (D11): a channel target that is not provably private
   * runs shared, no target runs private. `jobs.json` is rewritten whole, so an older
   * binary that does not know the field keeps it (pinned by
   * `__tests__/unknown-field-roundtrip.test.ts`).
   */
  roomAudience?: TurnAudience;
  status: JobStatus;
  missedRunPolicy: MissedRunPolicy;
  /** Repeat policy — defaults to 'forever' for cron/interval, 'once' for relative/iso. */
  repeat: RepeatPolicy;
  /** Number of times this job has been executed. */
  runCount: number;
  /** Last execution error, if any. */
  lastError?: string;
  /** Job ids/names whose latest output will be prepended as context at run time. */
  contextFrom?: string[];
  /** Wall-clock cap on a prompt job's agent turn, in ms. Absent = the
   *  scheduler's `defaultMaxRunMs`. Enforced by `CronScheduler.runTurnCapped`. */
  maxRunMs?: number;
  /** Ownership. 'system' jobs are seeded by the framework and non-disableable.
   *  Default 'user'. Distinct from `origin` (channel platform/chatId). */
  source?: 'system' | 'user';
  /** For source:'system' — the registered system-task handler name. Present iff source==='system'. */
  systemTask?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
  /**
   * Mid-execution signal (plan/phases/idle-watcher.md §1 check #7). Epoch ms
   * stamped inside `claimDueJob`'s compare-and-swap — so only the winning
   * claimant ever sets it — and cleared in `executeJob`'s `finally`, including
   * when the job throws. A turn abandoned at its `maxRunMs` keeps the stamp
   * until that turn's promise settles. A fresh stamp blocks a second claim and
   * `runJobNow` (`CronScheduler.isRunning`, UBP-026) — but only while its
   * `runningOwner` is this process or a live one. `null` or absent means "not running": records written
   * before this field existed simply have no key, which reads the same as
   * cleared. Read through `hasRunningJobs()`, never directly.
   */
  runningSince?: number | null;
  /**
   * The process that wrote `runningSince`, stamped and cleared with it. A stamp
   * whose owner is dead, from an earlier boot, or an earlier process that wore
   * this pid is a crash orphan and blocks nothing (`CronScheduler.isRunning`,
   * pinned by the 'crash-orphaned running stamp' cases in
   * `__tests__/run-integrity.test.ts`). A stamp with no owner was written
   * before owners were recorded and blocks nothing either.
   */
  runningOwner?: CronRunOwner | null;
  /** When the last failure notice for this job was delivered (ISO-8601). Rate-
   *  limits the notice a failed prompt run sends its origin to one per
   *  `CRON_FAILURE_NOTICE_INTERVAL_MS` (`CronScheduler.recordRunFailure`). */
  failureNoticeAt?: string;
}

/** Who holds a `CronJob.runningSince` stamp — the same identity the jobs lock
 *  records (`jobs-lock.ts`), plus a per-process token so a restarted process
 *  that is handed its predecessor's pid does not mistake that stamp for its
 *  own. */
export interface CronRunOwner {
  pid: number;
  /** `currentBootId()` — Linux only; `null` never proves a different boot. */
  boot: string | null;
  /** `PROCESS_RUN_TOKEN` of the writing process. */
  token: string;
}

/** One per process (not per scheduler), so every `CronScheduler` in this
 *  process recognises the others' stamps as live. */
const PROCESS_RUN_TOKEN = randomUUID();

export interface CronJobUpdate {
  name?: string;
  schedule?: string;
  prompt?: string;
  /** An object sets the script block; `null` clears it. */
  script?: ScriptRef | null;
  /** An object sets the precheck gate; `null` clears it. */
  precheck?: ScriptRef | null;
}

export interface CronRunResult {
  jobId: string;
  ranAt: string;
  output: string;
  sessionKey: string;
  /**
   * `audience: 'user'` tool progress observed during the run, collected by a
   * `CronProgressRecorder` in the job runner. Deliberately NOT part of
   * `output`: `output` is delivered verbatim to the originating channel and
   * `decideEscalation` tests it with a start-anchored `[SILENT]` regex, so
   * anything prepended or interleaved there would both add noise to every
   * delivered message and break silent-job suppression. See ./progress.ts.
   */
  progress?: CronRunProgress[];
  /**
   * Everything the turn streamed, across every LLM iteration, when it differs
   * from `output`. `output` is only the final answer — what is delivered and
   * what `decideEscalation` reads — so pre-tool narration can neither lead the
   * delivered message nor push a `[SILENT]` answer off position 0 (UBP-025).
   * The persisted run file keeps this full stream (`persistAndDeliver`).
   */
  transcript?: string;
}

export interface CronRunInfo {
  /** ISO-8601 timestamp parsed from the run output filename. */
  ranAt: string;
  /** Absolute path to the persisted markdown output. */
  outputPath: string;
  /**
   * Absolute path to the run's progress sidecar, present only when the run
   * recorded any. Runs persisted before progress capture existed have no
   * sidecar and simply omit this — `readRunProgress` returns `[]` either way.
   */
  progressPath?: string;
}

// ---------------------------------------------------------------------------
// Trigger seam (plan/completed/cron-scheduler-seam.md) — what a
// `CronTriggerSource` calls into, and who gets told when the next run is due.
// The mode is selected by one presence-gated config field, `cron.fireUrl`
// (plan/phases/cron-fire-url-collapse.md) — see `buildCronTriggers`.
// ---------------------------------------------------------------------------

/**
 * The shared due-scan / claim-before-run / execute cycle. `CronScheduler` is
 * today's only implementation (its `fire()` method) — the interface exists so
 * a trigger (an in-process interval, or an externally-fired HTTP request) can
 * drive it uniformly without depending on the concrete class. See `trigger.ts`
 * for `CronTriggerSource` (`LocalIntervalTrigger` / `HttpFireTrigger`).
 */
export interface CronEngine {
  fire(): Promise<void>;
}

/**
 * Told the next time work is due, so an external wake mechanism (e.g. a
 * future Firecracker Wake Controller) knows when to resume a sleeping
 * instance. `NoopArmingBackend` (see `trigger.ts`) is the only implementation
 * there is — arms nothing — but the `arm(nextRunAt)` contract is
 * exercised for real (see `CronScheduler`'s call site) so a later real backend
 * is designed against a tested signature, not a guessed one.
 */
export interface CronArmingBackend {
  arm(nextRunAt: Date | null): void | Promise<void>;
}

/** Per-call options the scheduler hands `runJob`. */
export interface CronRunJobOptions {
  /** Aborted when the turn exceeds its `maxRunMs`. Pass it to `AgentLoop.run`
   *  as `abortSignal` so the turn actually stops. */
  abortSignal: AbortSignal;
}

/** Built-in wall-clock cap on a prompt job's turn when neither the job nor
 *  `cron.defaultMaxRunMs` sets one. Below `CRON_RUNNING_STALE_MS`, so a capped
 *  run that honours its abort clears its `runningSince` stamp before the stamp
 *  reads stale; one that ignores it keeps the stamp until it settles. */
export const DEFAULT_CRON_MAX_RUN_MS = 30 * 60 * 1000;

/** The largest `maxRunMs` a timer can hold: Node clamps a `setTimeout` delay
 *  above 2^31-1 to 1ms, which would time every run out at once. Refused at
 *  `CronScheduler.createJob`, and clamped in `CronScheduler.runTurnCapped` for a
 *  value that arrives another way (a hand-edited jobs.json, the constructor's
 *  `defaultMaxRunMs`). `packages/config` mirrors it for `cron.defaultMaxRunMs`. */
export const MAX_CRON_RUN_MS = 2_147_483_647;

export interface CronSchedulerConfig {
  /** Called when a job fires. Returns the text output and session key. */
  runJob: (job: CronJob, opts?: CronRunJobOptions) => Promise<CronRunResult>;
  /** Wall-clock cap for a prompt job's turn that sets no `maxRunMs` (mapped
   *  from `cron.defaultMaxRunMs`). Default `DEFAULT_CRON_MAX_RUN_MS`. */
  defaultMaxRunMs?: number;
  /** Directory for jobs.json, its lock and the output/ run history. Required,
   *  with no default: every host passes `ethosCronDir()` from
   *  `@ethosagent/config`, which honours `ETHOS_STATE_DIR`. A `homedir()`
   *  default here once made an isolated state dir write the real
   *  `~/.ethos/cron/jobs.json`. */
  cronDir: string;
  /** Tick interval in ms. Default 60_000 (1 min). */
  tickIntervalMs?: number;
  /**
   * Cap on cron jobs executing at once across overlapping ticks (mapped from
   * `cron.maxParallelJobs`). A due job reached while the cap is met is left
   * unclaimed — `nextRunAt` is not advanced, so it stays due and fires on a
   * later tick rather than being dropped, and the deferral exempts it from the
   * `skip` policy (the cap check runs first in `tick()`). Unset = no cap.
   */
  maxParallelJobs?: number;
  /** Storage backend. Injected by the composition root; required — never
   *  falls back to raw disk. */
  storage: Storage;
  /** Logger for tick-time errors. Defaults to a silent NoopLogger. */
  logger?: Logger;
  /** Optional callback to deliver run output back to the originating channel. */
  deliver?: (job: CronJob, output: string) => Promise<void>;
  /** source:'system' jobs dispatch here by systemTask name instead of runJob. */
  systemTasks?: Record<string, (job: CronJob) => Promise<{ output: string }>>;
  /** Directory holding operator-authored scripts referenced by `script`/
   *  `precheck` blocks. Required, for the same reason as `cronDir`: hosts
   *  pass `ethosScriptsDir()` from `@ethosagent/config`. */
  scriptsDir: string;
  /** Execution backend for `script`/`precheck` runs. Injected at wiring
   *  time so the operator's execution posture applies to cron scripts;
   *  falls back to a lazily-constructed local backend when absent. */
  executionBackend?: ExecutionBackend;
  /** Fired after every executed run with the escalate-vs-silent decision — the heartbeat audit record. Failures are swallowed (audit is fail-open, never breaks the run). */
  onDecision?: (
    job: CronJob,
    decision: CronDecision & { ranAt: string; delivered: boolean },
  ) => void;
  /** Told the earliest `nextRunAt` across active jobs after every fire — the
   *  `CronArmingBackend` seam. Optional; when absent no arming call is made.
   *  Failures are swallowed (arming is fail-open, never breaks the run). */
  armingBackend?: CronArmingBackend;
  /**
   * The room audience a job's firing runs under, for `resolveContext`'s
   * fire-time audience check (plan personality-memory-boundary G1,
   * verification round E1): when the firing job runs shared, a `contextFrom`
   * reference that does not itself run shared is skipped, so a private job's
   * output never reaches a shared turn. Hosts pass `cronContextAudience`
   * (apps/ethos/src/commands/cron-turn.ts), the same `cronRunAudience` rule the
   * runner then applies to the turn. Absent → judged by the stamps alone
   * (`stampAudience` below): shared iff `roomAudience === 'shared'` on the job
   * or a job its `contextFrom` names. Pinned by the E1 cases in
   * `src/__tests__/cron.test.ts`.
   */
  runAudience?: (job: CronJob, jobs: readonly CronJob[]) => TurnAudience;
}

/**
 * Audit actions: heartbeat escalate/silent, the script-job outcomes, and the
 * two occurrences that did not run — `missed` (`skipMissed`, the `skip`
 * policy) and `overlap-skip` (the previous run still executing, UBP-026).
 */
export type CronDecisionAction =
  | HeartbeatAction
  | 'script-silent'
  | 'precheck-skip'
  | 'missed'
  | 'overlap-skip';

export interface CronDecision {
  action: CronDecisionAction;
  /** The run output (delivered verbatim when action === 'escalate'). */
  output: string;
}

// ---------------------------------------------------------------------------
// Script execution — zero-LLM `script:` jobs and `precheck` gates. All
// execution flows through an ExecutionBackend (never raw child_process) so
// the operator's sandbox posture applies to cron scripts too.
// ---------------------------------------------------------------------------

export const DEFAULT_SCRIPT_TIMEOUT_SECONDS = 60;
export const MAX_SCRIPT_TIMEOUT_SECONDS = 600;
/** A precheck exiting with this code skips the LLM turn entirely. */
export const PRECHECK_SKIP_EXIT_CODE = 78;

/** Interpreter fixed by extension — shebangs deliberately NOT honored. */
const SCRIPT_INTERPRETERS: Record<string, string> = {
  '.sh': 'bash',
  '.py': 'python3',
};

export interface ScriptRunOutcome {
  /** True when the script ran to completion (any exit code). False on
   *  timeout, spawn failure, or a missing/invalid script file. */
  ok: boolean;
  exitCode: number | null;
  /** Secret-redacted stdout. */
  stdout: string;
  /** Secret-redacted stderr. */
  stderr: string;
  /** Human-readable reason, set only when ok === false. */
  failure?: string;
}

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Resolve a script ref against the scripts directory with hard guards:
 *  no absolute paths, no `..` traversal, interpreter fixed by extension. */
function resolveScriptFile(
  ref: ScriptRef,
  scriptsDir: string,
  label: string,
): { absPath: string; interpreter: string } {
  if (!ref.file) throw new Error(`${label}.file is required`);
  if (ref.timeoutSeconds !== undefined) {
    if (
      !Number.isInteger(ref.timeoutSeconds) ||
      ref.timeoutSeconds < 1 ||
      ref.timeoutSeconds > MAX_SCRIPT_TIMEOUT_SECONDS
    ) {
      throw new Error(
        `${label}.timeoutSeconds must be an integer between 1 and ${MAX_SCRIPT_TIMEOUT_SECONDS}`,
      );
    }
  }
  if (isAbsolute(ref.file)) {
    throw new Error(`${label} path must be relative to the scripts directory: "${ref.file}"`);
  }
  const absPath = resolve(scriptsDir, ref.file);
  const rel = relative(scriptsDir, absPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} path escapes the scripts directory: "${ref.file}"`);
  }
  const interpreter = SCRIPT_INTERPRETERS[extname(absPath)];
  if (!interpreter) {
    throw new Error(
      `${label} "${ref.file}" has an unsupported extension — only .sh (bash) and .py (python3) scripts are allowed`,
    );
  }
  return { absPath, interpreter };
}

export interface RunScriptFileOpts {
  storage: Storage;
  executionBackend: ExecutionBackend;
  /** Directory the script ref resolves against. Required — hosts pass
   *  `ethosScriptsDir()` from `@ethosagent/config`. */
  scriptsDir: string;
  /** Raw text piped to the script's stdin (e.g. a webhook request body). */
  stdin?: string;
  /** Label used in error messages: 'script' | 'precheck' | 'prefilter'. */
  label?: string;
}

/**
 * Run an operator-authored script from the scripts directory through an
 * ExecutionBackend. Shared by cron `script:` jobs / `precheck` gates and the
 * webhook prefilter — same path guards, same fixed-interpreter rule, same
 * secret redaction. Never throws — outcomes (including timeout and missing
 * file) are returned for the caller to apply its own semantics.
 */
export async function runScriptFile(
  ref: ScriptRef,
  opts: RunScriptFileOpts,
): Promise<ScriptRunOutcome> {
  const scriptsDir = opts.scriptsDir;
  const label = opts.label ?? 'script';
  let absPath: string;
  let interpreter: string;
  try {
    ({ absPath, interpreter } = resolveScriptFile(ref, scriptsDir, label));
  } catch (err) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      failure: err instanceof Error ? err.message : String(err),
    };
  }
  if (!(await opts.storage.exists(absPath))) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      failure: `script "${ref.file}" not found in ${scriptsDir}`,
    };
  }

  const timeoutSeconds = ref.timeoutSeconds ?? DEFAULT_SCRIPT_TIMEOUT_SECONDS;
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  try {
    const cmd = `${interpreter} ${shellQuote(absPath)}`;
    for await (const chunk of opts.executionBackend.exec(cmd, {
      timeoutMs: timeoutSeconds * 1000,
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
    })) {
      if (chunk.stream === 'stdout') stdout += chunk.data;
      else if (chunk.stream === 'stderr') stderr += chunk.data;
      else if (chunk.stream === 'exit') exitCode = chunk.code;
    }
  } catch (err) {
    const timedOut = errorCode(err) === 'EXEC_TIMEOUT';
    return {
      ok: false,
      exitCode: null,
      stdout: redactString(stdout),
      stderr: redactString(stderr),
      failure: timedOut
        ? `script "${ref.file}" timed out after ${timeoutSeconds}s`
        : `script "${ref.file}" failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    exitCode: exitCode ?? -1,
    stdout: redactString(stdout),
    stderr: redactString(stderr),
  };
}

/** The local backend ignores its construction context entirely — this noop
 *  resolver only satisfies the factory contract for the internal fallback. */
const noopSecrets: SecretsResolver = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(),
  list: () => Promise.resolve([]),
};

// ---------------------------------------------------------------------------
// CronScheduler
// ---------------------------------------------------------------------------

/**
 * Staleness bound on `CronJob.runningSince`, applied at READ time by
 * `hasRunningJobs()` and — raised to the job's own turn cap when that is
 * longer — by `CronScheduler.isRunning`, the overlap guard on a claim and on
 * `runJobNow`.
 *
 * `runningSince` is persisted (jobs.json), so a process killed mid-run leaves
 * a stamp with nobody behind it. This is the equivalent of
 * `JobStore.reclaimStale(staleMs)` — with one deliberate difference: there is
 * no sweep that rewrites the record. `runningSince` has no state machine to
 * transition into,
 * unlike a job row that must move `running` → `stale`, so a ghost stamp only
 * needs to stop reading as busy (and stop blocking a claim). It ages out here,
 * and the job's next claim overwrites it outright.
 *
 * One hour, because a cron prompt job is a full agent turn with tool calls and
 * has no heartbeat to shorten this against. Erring long is the safe direction:
 * too short reports a genuinely-running job idle, which is the failure mode
 * that loses work; too long only delays a suspend.
 */
export const CRON_RUNNING_STALE_MS = 60 * 60 * 1000;

/**
 * Minimum gap between two failure notices for one job (UBP-029). A job failing
 * every five minutes through a provider outage tells its chat once, not every
 * run; `lastError` still records every failure. Enforced by
 * `CronScheduler.recordRunFailure` against `CronJob.failureNoticeAt`.
 */
export const CRON_FAILURE_NOTICE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class CronScheduler {
  private readonly cronDir: string;
  private readonly jobsPath: string;
  private readonly lockPath: string;
  private readonly outputDir: string;
  private readonly runJob: (job: CronJob, opts?: CronRunJobOptions) => Promise<CronRunResult>;
  private readonly defaultMaxRunMs: number;
  private readonly tickIntervalMs: number;
  /** `null` = uncapped. See `CronSchedulerConfig.maxParallelJobs`. */
  private readonly maxParallelJobs: number | null;
  /** Jobs currently executing, across every concurrent `tick()`. */
  private inFlight = 0;
  /** Due jobs this process left unclaimed at the `maxParallelJobs` cap. A
   *  deferral is not a miss, so these are exempt from the skip policy until
   *  they are claimed (UBP-027). */
  private readonly deferred = new Set<string>();
  /** When the previous `tick()` started — an occurrence due after it could
   *  not have run earlier, so it is never a miss (UBP-027, V-CC-3). */
  private lastTickAtMs: number | null = null;
  /** When this scheduler was constructed — the "process start" a first tick
   *  measures downtime against. */
  private readonly startedAtMs = Date.now();
  private readonly storage: Storage;
  private readonly logger: Logger;
  private readonly deliver?: (job: CronJob, output: string) => Promise<void>;
  private readonly systemTasks: Record<string, (job: CronJob) => Promise<{ output: string }>>;
  private readonly scriptsDir: string;
  private executionBackend: ExecutionBackend | null;
  private readonly onDecision?: (
    job: CronJob,
    decision: CronDecision & { ranAt: string; delivered: boolean },
  ) => void;
  private armingBackend?: CronArmingBackend;
  private readonly runAudience: (job: CronJob, jobs: readonly CronJob[]) => TurnAudience;

  constructor(config: CronSchedulerConfig) {
    this.cronDir = config.cronDir;
    this.jobsPath = join(this.cronDir, 'jobs.json');
    this.lockPath = join(this.cronDir, 'jobs.json.lock');
    this.outputDir = join(this.cronDir, 'output');
    this.runJob = config.runJob;
    this.defaultMaxRunMs = config.defaultMaxRunMs ?? DEFAULT_CRON_MAX_RUN_MS;
    this.tickIntervalMs = config.tickIntervalMs ?? 60_000;
    this.maxParallelJobs = config.maxParallelJobs ?? null;
    this.storage = config.storage;
    this.logger = config.logger ?? noopLogger;
    this.deliver = config.deliver;
    this.systemTasks = config.systemTasks ?? {};
    this.scriptsDir = config.scriptsDir;
    this.executionBackend = config.executionBackend ?? null;
    this.onDecision = config.onDecision;
    this.armingBackend = config.armingBackend;
    this.runAudience = config.runAudience ?? stampAudience;
  }

  /**
   * Late-bind the `CronArmingBackend` after construction. Exists because
   * `buildCronTriggers` (trigger.ts) needs the already-constructed
   * `CronScheduler` as its `engine` argument, so the arming backend it
   * produces can't be passed into this scheduler's own constructor —
   * callers build the scheduler first, then `buildCronTriggers(scheduler,
   * ...)`, then wire the result back with this setter. `tick()` reads
   * `this.armingBackend` at call time (see the end of `tick()`), so a
   * value set after construction — including after the first `fire()` —
   * is picked up on every subsequent tick.
   */
  setArmingBackend(backend: CronArmingBackend): void {
    this.armingBackend = backend;
  }

  // ---------------------------------------------------------------------------
  // Engine entry point — `CronEngine.fire()`. The in-process interval loop
  // that used to live here (`start()`/`stop()`) has moved to
  // `LocalIntervalTrigger` (see `trigger.ts`); this class is the engine a
  // `CronTriggerSource` fires into, not the thing that owns the timer.
  // ---------------------------------------------------------------------------

  /** Run the due-scan/claim/execute cycle once, right now. Called by a
   *  `CronTriggerSource` — an interval loop, or an externally-fired HTTP
   *  request (`POST /cron/fire`). */
  async fire(): Promise<void> {
    await this.tick();
  }

  // ---------------------------------------------------------------------------
  // Job management (used by tools-cron and CLI)
  // ---------------------------------------------------------------------------

  async createJob(
    params: Omit<CronJob, 'id' | 'createdAt' | 'nextRunAt' | 'status' | 'runCount' | 'repeat'> & {
      repeat?: RepeatPolicy;
      /**
       * Explicit, immutable job id. Defaults to a slug of `name`, which is what
       * every user-facing caller wants. `reconcileSystemJob` passes it so that
       * a system job's identity survives a rename of its display `name`.
       */
      id?: string;
    },
  ): Promise<CronJob> {
    if (!params.personalityId) {
      throw new Error('personalityId is required');
    }

    // An id becomes a directory name under `<cronDir>/output/`, so an explicit
    // one is held to the same charset `jobIdForName` produces and `listRuns` guards.
    if (params.id !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(params.id)) {
      throw new Error(`Invalid job id: "${params.id}"`);
    }

    if (!isValidSchedule(params.schedule)) {
      throw new Error(`Invalid schedule: "${params.schedule}"`);
    }

    if (params.script && params.prompt) {
      throw new Error('script and prompt are mutually exclusive — set one, not both');
    }

    if (params.script && params.source === 'system') {
      throw new Error('script is not allowed on system jobs — use systemTask');
    }

    if (params.precheck) {
      if (params.source === 'system') {
        throw new Error('precheck is not allowed on system jobs');
      }
      if (params.script || !params.prompt) {
        throw new Error('precheck is only allowed on prompt jobs');
      }
    }

    // prompt is required for user jobs unless a script is set; system jobs use systemTask
    if (params.source !== 'system' && !params.prompt && !params.script) {
      throw new Error('prompt is required for user jobs');
    }

    if (
      params.maxRunMs !== undefined &&
      (!Number.isInteger(params.maxRunMs) || params.maxRunMs < 1)
    ) {
      throw new Error('maxRunMs must be a positive integer (milliseconds)');
    }
    if (params.maxRunMs !== undefined && params.maxRunMs > MAX_CRON_RUN_MS) {
      throw new Error(
        `maxRunMs must be at most ${MAX_CRON_RUN_MS} (about 24.8 days); got ${params.maxRunMs}`,
      );
    }

    if (params.script) await this.validateScriptRef(params.script, 'script');
    if (params.precheck) await this.validateScriptRef(params.precheck, 'precheck');

    const now = new Date();
    const repeat: RepeatPolicy =
      params.repeat ??
      (isOneShotSchedule(params.schedule) ? { kind: 'once' } : { kind: 'forever' });

    const job: CronJob = {
      ...params,
      id: params.id ?? jobIdForName(params.name),
      source: params.source ?? 'user',
      systemTask: params.systemTask,
      status: 'active',
      missedRunPolicy: params.missedRunPolicy ?? 'skip',
      repeat,
      runCount: 0,
      nextRunAt: nextRunForSchedule(params.schedule, now)?.toISOString(),
      createdAt: now.toISOString(),
    };

    await this.withJobsLock(async (jobs) => {
      if (jobs.find((j) => j.id === job.id)) {
        throw new Error(`Job with id "${job.id}" already exists`);
      }
      if (job.contextFrom && job.contextFrom.length > 0) {
        // Another personality's job is an unknown reference (S15): the same
        // text, so this is not an existence oracle. Re-checked at fire time by
        // `resolveContext`.
        for (const ref of job.contextFrom) {
          if (!findOwnedRef(jobs, ref, job.personalityId)) {
            throw new Error(`contextFrom references unknown job: "${ref}"`);
          }
        }
      }
      jobs.push(job);
      return jobs;
    });

    return job;
  }

  async listJobs(): Promise<CronJob[]> {
    return this.readJobs();
  }

  async getJob(id: string): Promise<CronJob | null> {
    const jobs = await this.readJobs();
    return jobs.find((j) => j.id === id) ?? null;
  }

  async deleteJob(id: string): Promise<void> {
    await this.withJobsLock(async (jobs) => {
      const job = jobs.find((j) => j.id === id);
      if (!job) throw new Error(`Job not found: ${id}`);
      if (job.source === 'system') {
        throw new Error(`Cannot delete system job "${id}" — managed by operator config`);
      }
      return jobs.filter((j) => j.id !== id);
    });
  }

  async pauseJob(id: string): Promise<void> {
    const job = await this.getJob(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    if (job.source === 'system') {
      throw new Error(`Cannot pause system job "${id}" — managed by operator config`);
    }
    await this.patchJob(id, { status: 'paused' });
  }

  async resumeJob(id: string): Promise<void> {
    const job = await this.getJob(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    const now = new Date();
    const upcoming = nextRunForSchedule(job.schedule, now, new Date(job.createdAt));
    // A one-shot whose moment has passed (it was paused after a failed run —
    // see `recordRunFailure`) is due NOW on resume. Without this it would come
    // back with no `nextRunAt` and the next tick would retire it unrun.
    const nextRunAt =
      upcoming ?? (isOneShotSchedule(job.schedule) && job.runCount === 0 ? now : undefined);
    await this.patchJob(id, { status: 'active', nextRunAt: nextRunAt?.toISOString() });
  }

  async updateJob(id: string, patch: CronJobUpdate): Promise<CronJob> {
    if (
      !patch.name &&
      !patch.schedule &&
      patch.prompt === undefined &&
      patch.script === undefined &&
      patch.precheck === undefined
    ) {
      throw new Error('At least one of name, schedule, prompt, script, or precheck is required');
    }

    // Path/extension/existence guards run before the lock — same rules as create.
    if (patch.script) await this.validateScriptRef(patch.script, 'script');
    if (patch.precheck) await this.validateScriptRef(patch.precheck, 'precheck');

    let updatedJob: CronJob | undefined;

    await this.withJobsLock(async (jobs) => {
      const idx = jobs.findIndex((j) => j.id === id);
      const existing = idx >= 0 ? jobs[idx] : undefined;
      if (!existing) throw new Error(`Job not found: ${id}`);

      // Same exclusivity rules as createJob, validated against the merged state
      // so a patch cannot leave a job with both script and prompt set.
      const nextPrompt = patch.prompt !== undefined ? patch.prompt : existing.prompt;
      const nextScript = patch.script !== undefined ? (patch.script ?? undefined) : existing.script;
      const nextPrecheck =
        patch.precheck !== undefined ? (patch.precheck ?? undefined) : existing.precheck;
      if (nextPrompt && nextScript) {
        throw new Error('script and prompt are mutually exclusive — set one, not both');
      }
      if (nextScript && existing.source === 'system') {
        throw new Error('script is not allowed on system jobs — use systemTask');
      }
      if (nextPrecheck) {
        if (existing.source === 'system') {
          throw new Error('precheck is not allowed on system jobs');
        }
        if (nextScript || !nextPrompt) {
          throw new Error('precheck is only allowed on prompt jobs');
        }
      }
      if (existing.source !== 'system' && !nextPrompt && !nextScript) {
        throw new Error('user jobs require a prompt or a script');
      }

      if (patch.schedule) {
        if (!isValidSchedule(patch.schedule)) {
          throw new Error(`Invalid schedule: "${patch.schedule}"`);
        }
        const nextAt = nextRunForSchedule(patch.schedule, new Date(), new Date(existing.createdAt));
        const wasOneShot = isOneShotSchedule(existing.schedule);
        existing.schedule = patch.schedule;
        existing.nextRunAt = nextAt?.toISOString();
        // Recompute repeat if schedule changed to one-shot and repeat was forever
        if (isOneShotSchedule(patch.schedule) && existing.repeat.kind === 'forever') {
          existing.repeat = { kind: 'once' };
        } else if (
          wasOneShot &&
          !isOneShotSchedule(patch.schedule) &&
          existing.repeat.kind === 'once'
        ) {
          // Inverse of the rule above: a one-shot's `once` was implied by its schedule,
          // so it goes when the schedule stops being one-shot. An explicit `once` on a
          // recurring schedule is left alone (D7). `count` and `status` are never
          // touched here — a retired job comes back only through resumeJob.
          // Pinned by the "CronScheduler updateJob" tests in __tests__/cron.test.ts.
          existing.repeat = { kind: 'forever' };
        }
      }
      if (patch.name !== undefined) existing.name = patch.name;
      if (patch.prompt !== undefined) existing.prompt = patch.prompt;
      if (patch.script !== undefined) {
        if (patch.script === null) delete existing.script;
        else existing.script = patch.script;
      }
      if (patch.precheck !== undefined) {
        if (patch.precheck === null) delete existing.precheck;
        else existing.precheck = patch.precheck;
      }

      jobs[idx] = existing;
      updatedJob = existing;
      return jobs;
    });

    if (!updatedJob) throw new Error(`Job not found: ${id}`);
    return updatedJob;
  }

  async runJobNow(id: string): Promise<CronRunResult> {
    const job = await this.getJob(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    // A manual run is mid-execution too, so it stamps `runningSince` — and it
    // is refused while another run of the same job holds a fresh stamp
    // (UBP-026): "Run now" during a scheduled run would otherwise execute the
    // turn, its side effects and its delivery twice. Checked and stamped in one
    // jobs-lock critical section, like `claimDueJob`.
    const runningStamp = Date.now();
    const busy: { since: number | null } = { since: null };
    // A lock that cannot be taken fails the run closed: running without the
    // overlap check is the double execution this exists to prevent (V-CC-6).
    await this.withJobsLock(async (jobs) => {
      const idx = jobs.findIndex((j) => j.id === id);
      const existing = idx >= 0 ? jobs[idx] : undefined;
      if (!existing) return jobs;
      if (this.isRunning(existing, runningStamp)) {
        busy.since = existing.runningSince ?? null;
        return jobs;
      }
      jobs[idx] = { ...existing, runningSince: runningStamp, runningOwner: runOwner() };
      return jobs;
    }).catch((err: unknown) => {
      throw new Error(
        `Could not check whether job "${id}" is already running, so it was not run: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    if (busy.since !== null) {
      throw new Error(
        `Job "${id}" is already running (started ${new Date(busy.since).toISOString()}) — wait for that run to finish`,
      );
    }
    try {
      return await this.executeJob(job, runningStamp);
    } catch (err) {
      // A failed manual run is on the job's record too, not only in the
      // caller's error (UBP-004). No pause and no notice: a person asked for
      // this run and is looking at its result.
      await this.patchJob(id, {
        lastError: err instanceof Error ? err.message : String(err),
      }).catch(() => {});
      throw err;
    }
  }

  /**
   * Whether `job` holds a FRESH mid-execution stamp at `nowMs`. Fresh means
   * younger than the larger of `CRON_RUNNING_STALE_MS` and the job's own turn
   * cap, so a legitimately long run is never mistaken for a ghost stamp left
   * by a killed process. The one overlap test for `claimDueJob` and
   * `runJobNow`.
   *
   * A stamp counts only while its owner can still be running it
   * (`runOwnerAlive`): a process killed mid-run leaves a stamp nobody will
   * clear, and blocking on it would hold the job off for up to `maxRunMs`
   * after a restart (V-CC-2).
   */
  private isRunning(job: CronJob, nowMs: number): boolean {
    if (typeof job.runningSince !== 'number') return false;
    if (!runOwnerAlive(job.runningOwner)) return false;
    const staleMs = Math.max(CRON_RUNNING_STALE_MS, job.maxRunMs ?? this.defaultMaxRunMs);
    return job.runningSince > nowMs - staleMs;
  }

  /**
   * Whether any job is mid-execution right now — the aggregate the idle
   * watcher's `cron-executions` busy source reads (plan §1 check #7).
   *
   * Reads `runningSince` off jobs.json rather than an in-process Map on
   * purpose: in a hybrid deployment several processes share one cron dir, and
   * a run started by a peer is still work this VM must not be suspended
   * through. Stamps older than `staleMs` are ignored — see
   * `CRON_RUNNING_STALE_MS` — and so is a stamp whose owner cannot still be
   * running it (`runOwnerAlive`, the same rule `isRunning` applies): a crash
   * orphan must not keep the machine awake any more than it blocks a claim.
   * Pinned by the 'owner liveness' cases in `__tests__/run-integrity.test.ts`.
   */
  async hasRunningJobs(staleMs: number = CRON_RUNNING_STALE_MS): Promise<boolean> {
    const cutoff = Date.now() - staleMs;
    const jobs = await this.readJobs();
    return jobs.some(
      (j) =>
        typeof j.runningSince === 'number' &&
        j.runningSince > cutoff &&
        runOwnerAlive(j.runningOwner),
    );
  }

  /**
   * Idempotent seeder for system-managed cron jobs. If a job with the
   * slugified name already exists, returns it unchanged; otherwise creates
   * a new source:'system' job with the given schedule and systemTask handler.
   */
  async seedSystemJob(params: {
    name: string;
    schedule: string;
    systemTask: string;
    personalityId?: string;
  }): Promise<CronJob> {
    const id = jobIdForName(params.name);
    const existing = await this.getJob(id);
    if (existing) return existing;
    return this.createJob({
      name: params.name,
      schedule: params.schedule,
      prompt: '',
      personalityId: params.personalityId ?? 'system',
      source: 'system',
      systemTask: params.systemTask,
      missedRunPolicy: 'skip',
    });
  }

  /**
   * Reconcile ONE system-managed cron job against what the operator's config
   * now says, and return what had to change.
   *
   * `seedSystemJob` only ever creates: a schedule edited in config.yaml, a
   * handler renamed in code, or a feature switched off all left the old job
   * running exactly as it was, so the scheduler and the config disagreed
   * forever with nothing to say so. This is the reconciling half.
   *
   * Deliberately config-SHAPE-agnostic — it takes an `enabled` boolean, not an
   * `EthosConfig` — so `extensions/cron` keeps knowing nothing about the
   * operator config schema. The EthosConfig -> spec mapping lives one layer
   * out, in `seedAllSystemJobs` (`@ethosagent/wiring`).
   *
   * Identity is the caller's explicit `id`, NOT a slug of `name`. `name` is
   * display copy: renaming "Backup" to "Nightly backup" must PATCH the one job,
   * and a name-derived id would instead create a second job while the first
   * kept firing — an orphan generator, not a reconciler.
   *
   * Only ever touches jobs it owns: an id occupied by a `source:'user'` job is
   * left alone rather than overwritten, because a user's job is their data. But
   * that is reported as `'conflict'`, not `'unchanged'` — the desired state does
   * NOT hold, the system job does not exist, and a caller that hears
   * "unchanged" would never say so. A changed `systemTask` is a
   * remove-and-recreate: `CronJobUpdate` has no `systemTask` field, and a job
   * pointing at a handler name that no longer exists throws on every tick.
   */
  async reconcileSystemJob(params: {
    /** Immutable identity. Never derived from `name`. */
    id: string;
    name: string;
    schedule: string;
    systemTask: string;
    personalityId?: string;
    /** `false` removes the job. Defaults to true. */
    enabled?: boolean;
  }): Promise<{
    action: 'created' | 'patched' | 'removed' | 'unchanged' | 'conflict';
    job: CronJob | null;
  }> {
    const id = params.id;
    const existing = await this.getJob(id);

    if (params.enabled === false) {
      if (!existing) return { action: 'unchanged', job: null };
      if (existing.source !== 'system') return { action: 'conflict', job: existing };
      await this.removeSystemJob(id);
      return { action: 'removed', job: null };
    }

    const create = async () => ({
      action: 'created' as const,
      job: await this.createJob({
        id,
        name: params.name,
        schedule: params.schedule,
        prompt: '',
        personalityId: params.personalityId ?? 'system',
        source: 'system' as const,
        systemTask: params.systemTask,
        missedRunPolicy: 'skip' as const,
      }),
    });

    if (!existing) return create();
    if (existing.source !== 'system') return { action: 'conflict', job: existing };
    if (existing.systemTask !== params.systemTask) {
      await this.removeSystemJob(id);
      return create();
    }
    const patch: CronJobUpdate = {};
    if (existing.schedule !== params.schedule) patch.schedule = params.schedule;
    // `name` is mutable presentation data. Without this the display drifts from
    // config the moment a spec is renamed, and never converges.
    if (existing.name !== params.name) patch.name = params.name;
    if (Object.keys(patch).length > 0) {
      return { action: 'patched', job: await this.updateJob(id, patch) };
    }
    return { action: 'unchanged', job: existing };
  }

  /**
   * Framework-level removal of a `source:'system'` job — the deregistration
   * path for watcher-backed ticks and other dynamically-managed system jobs.
   * Deliberately bypasses the user-facing `deleteJob` guard (which refuses
   * system jobs); never exposed through agent tools. Idempotent: a missing
   * id, or an id owned by a user job, is a no-op.
   */
  async removeSystemJob(id: string): Promise<void> {
    await this.withJobsLock(async (jobs) =>
      jobs.filter((j) => !(j.id === id && j.source === 'system')),
    );
  }

  // ---------------------------------------------------------------------------
  // Run history — read-only access to <cronDir>/output/<jobId>/<ts>.md
  // ---------------------------------------------------------------------------

  /**
   * List run-output files for `jobId`, newest first. Returns at most
   * `limit` entries (default 20). Each `CronRunInfo` has the run's
   * timestamp + the absolute output path; bodies are read on demand
   * via `readRunOutput` so a long history doesn't load megabytes of
   * markdown.
   */
  async listRuns(jobId: string, limit = 20): Promise<CronRunInfo[]> {
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) {
      return [];
    }
    const dir = join(this.outputDir, jobId);
    const names = await this.storage.list(dir);
    // Sidecars are detected from the SAME listing rather than an exists()
    // per run — the names are already in hand.
    const sidecars = new Set(names.filter((n) => n.endsWith(PROGRESS_SUFFIX)));
    return names
      .filter((n) => n.endsWith('.md'))
      .map((name) => {
        const sidecar = `${name.slice(0, -'.md'.length)}${PROGRESS_SUFFIX}`;
        return {
          ranAt: filenameToIso(name),
          outputPath: join(dir, name),
          ...(sidecars.has(sidecar) ? { progressPath: join(dir, sidecar) } : {}),
        };
      })
      .sort((a, b) => (a.ranAt < b.ranAt ? 1 : -1))
      .slice(0, limit);
  }

  /** Read the full output body for a single run. */
  async readRunOutput(outputPath: string): Promise<string> {
    const out = await this.storage.read(this.assertInOutputDir(outputPath));
    if (out === null) throw new Error(`Run output not found: ${outputPath}`);
    return out;
  }

  /**
   * Read the recorded `audience: 'user'` tool progress for a single run,
   * given that run's OUTPUT path. Returns `[]` when the run predates progress
   * capture, recorded none, or left an unparseable sidecar — missing progress
   * is the common case, not an error, and must never fail a run read.
   */
  async readRunProgress(outputPath: string): Promise<CronRunProgress[]> {
    const resolved = this.assertInOutputDir(outputPath);
    return parseRunProgress(await this.storage.read(progressPathFor(resolved)));
  }

  /** Guard: refuse any run path that escapes the output directory. */
  private assertInOutputDir(outputPath: string): string {
    const resolved = resolve(outputPath);
    const rel = relative(this.outputDir, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Path outside output directory: ${outputPath}`);
    }
    return resolved;
  }

  // ---------------------------------------------------------------------------
  // Tick — called every minute
  // ---------------------------------------------------------------------------

  private async tick(): Promise<void> {
    const now = new Date();
    const nowMs = now.getTime();
    // UBP-027 — an occurrence is MISSED only when an earlier chance to run it
    // existed: it fell due before the previous tick, or — on this process's
    // first tick — before the process started (downtime). One due since the
    // previous fire could not have run sooner, however far apart the fires are
    // (an external `POST /cron/fire` every 5 minutes; V-CC-3). Both also need
    // to be more than two intervals late, so a tick a few hundred ms late is
    // never a miss. Consequence: a laptop that sleeps through an occurrence
    // runs it once on wake — the process was up, and nothing distinguishes a
    // sleep from a sparse external fire before a cadence is known.
    const missedBeforeMs = this.lastTickAtMs ?? this.startedAtMs;
    const missedGraceMs = 2 * this.tickIntervalMs;
    this.lastTickAtMs = nowMs;
    const jobs = await this.readJobs();

    for (const job of jobs) {
      if (job.status !== 'active') continue;

      // Bug 3 fix: active job with no nextRunAt — try to recompute it.
      if (!job.nextRunAt) {
        // A claimed one-shot has no `nextRunAt` while its turn runs; it is not
        // elapsed, it is executing (V-CC-5).
        if (this.isRunning(job, nowMs)) continue;
        const upcoming = nextRunForSchedule(job.schedule, now, new Date(job.createdAt));
        if (upcoming) {
          await this.patchJob(job.id, { nextRunAt: upcoming.toISOString() }).catch(() => {});
        } else {
          // One-shot schedule has fully elapsed — retire the job, on the record
          // when it never completed a run (a claim a killed process abandoned).
          const retire: Partial<CronJob> = { status: 'done' };
          if ((job.runCount ?? 0) === 0) {
            retire.lastError = `retired without completing a run: its one-shot time (${job.schedule}) has passed`;
            this.logger.warn(`[cron] One-shot job "${job.id}" retired without a completed run`, {
              component: 'cron',
              jobId: job.id,
            });
          }
          await this.patchJob(job.id, retire).catch(() => {});
        }
        continue;
      }

      const due = new Date(job.nextRunAt);
      if (now < due) continue;

      // `cron.maxParallelJobs` — stop firing once the in-flight count is at the
      // cap. Checked BEFORE the skip policy and the claim: the deferred job
      // keeps its `nextRunAt`, stays due for a later tick, and is remembered as
      // deferred so the wait is never mistaken for a missed run (UBP-027).
      if (this.maxParallelJobs !== null && this.inFlight >= this.maxParallelJobs) {
        this.deferred.add(job.id);
        this.logger.debug('[cron] parallel job cap reached — deferring due job', {
          component: 'cron',
          jobId: job.id,
          inFlight: this.inFlight,
          maxParallelJobs: this.maxParallelJobs,
        });
        continue;
      }

      // Skip policy: only when the job is genuinely overdue (the engine was not
      // being fired at its due time) — see `missedGraceMs` above.
      const missedByMs = nowMs - due.getTime();
      if (
        job.missedRunPolicy === 'skip' &&
        due.getTime() < missedBeforeMs &&
        missedByMs > missedGraceMs &&
        !this.deferred.has(job.id)
      ) {
        await this.skipMissed(job, due, now);
        continue;
      }

      // Claim the job by advancing nextRunAt BEFORE executing so a crash
      // mid-run doesn't double-fire on the next tick. `claimDueJob` re-checks
      // `nextRunAt` against this tick's snapshot INSIDE the jobs lock — a
      // real compare-and-swap, not a last-write-wins patch — so two `tick()`
      // calls racing on the same due job (a local interval and an externally
      // fired `POST /cron/fire` landing close together) can't both win the
      // claim and both execute it.
      const upcoming = nextRunForSchedule(job.schedule, now, new Date(job.createdAt));
      // Stamped inside the CAS below, so a losing claimant never writes it.
      const runningStamp = Date.now();
      let claim: ClaimOutcome;
      try {
        claim = await this.claimDueJob(job.id, job.nextRunAt, {
          lastRunAt: now.toISOString(),
          nextRunAt: upcoming?.toISOString(),
          runningSince: runningStamp,
          runningOwner: runOwner(),
        });
      } catch (err) {
        this.logger.error(`[cron] Could not claim job "${job.id}", skipping tick`, {
          component: 'cron',
          jobId: job.id,
          error: String(err),
        });
        continue;
      }
      if (claim.kind === 'lost') {
        // Another concurrent tick already claimed this job — expected
        // whenever a local interval and an external fire overlap, not an
        // error.
        continue;
      }
      if (claim.kind === 'overlap') {
        // UBP-026 — the previous run of this job is still executing. Never a
        // second concurrent copy: the occurrence is skipped, on the record.
        const since = new Date(claim.runningSince).toISOString();
        this.logger.warn(
          `[cron] Job "${job.id}" still running since ${since} — occurrence skipped`,
          {
            component: 'cron',
            jobId: job.id,
          },
        );
        const skipped = `[skipped: overlap] due ${job.nextRunAt}; the previous run (started ${since}) was still executing`;
        await this.persistRun(job, skipped, now.toISOString()).catch(() => {});
        this.notifyDecision(
          job,
          { action: 'overlap-skip', output: skipped },
          now.toISOString(),
          false,
        );
        continue;
      }
      this.deferred.delete(job.id);

      this.inFlight++;
      try {
        await this.executeJob(job, runningStamp);
      } catch (err) {
        await this.recordRunFailure(job, err, upcoming === null);
        continue;
      } finally {
        this.inFlight--;
      }

      // After successful execution: increment runCount and check retirement.
      const updatedRunCount = (job.runCount ?? 0) + 1;
      const repeat = job.repeat ?? { kind: 'forever' };
      const patchData: Partial<CronJob> = { runCount: updatedRunCount };

      if (
        repeat.kind === 'once' ||
        (repeat.kind === 'count' &&
          repeat.maxRuns !== undefined &&
          updatedRunCount >= repeat.maxRuns)
      ) {
        patchData.status = 'done';
        patchData.nextRunAt = undefined;
      }

      await this.patchJob(job.id, patchData).catch(() => {});
    }

    if (this.armingBackend) {
      try {
        const afterTick = await this.readJobs();
        const nextTimes = afterTick
          .filter(
            (j): j is CronJob & { nextRunAt: string } => j.status === 'active' && !!j.nextRunAt,
          )
          .map((j) => new Date(j.nextRunAt).getTime())
          .filter((t) => Number.isFinite(t));
        const earliest = nextTimes.length > 0 ? new Date(Math.min(...nextTimes)) : null;
        await this.armingBackend.arm(earliest);
      } catch {
        // arming is fail-open — never breaks the tick
      }
    }
  }

  /**
   * UBP-027 — the `skip` policy's miss, on the record. A recurring job's
   * occurrence is skipped (nextRunAt advanced) with a run-history entry and a
   * warning. A one-shot has no later occurrence, so it is retired — but never
   * silently: `lastError` names the miss and its origin gets a notice, because
   * the user was promised this run and would otherwise never learn it did not
   * happen.
   */
  private async skipMissed(job: CronJob, due: Date, now: Date): Promise<void> {
    const lateSec = Math.round((now.getTime() - due.getTime()) / 1000);
    const reason = `missed: due ${due.toISOString()}, reached ${lateSec}s late (missedRunPolicy 'skip')`;
    this.logger.warn(`[cron] Job "${job.id}" ${reason}`, { component: 'cron', jobId: job.id });
    const skipped = `[skipped: ${reason}]`;
    await this.persistRun(job, skipped, now.toISOString()).catch(() => {});
    const upcoming = nextRunForSchedule(job.schedule, now, new Date(job.createdAt));
    if (upcoming) {
      await this.patchJob(job.id, { nextRunAt: upcoming.toISOString() }).catch(() => {});
      this.notifyDecision(job, { action: 'missed', output: skipped }, now.toISOString(), false);
      return;
    }
    const delivered = await this.deliverTo(
      job,
      `Cron job "${job.name}" was due at ${due.toISOString()} but was missed, so it did not run.`,
    );
    this.notifyDecision(job, { action: 'missed', output: skipped }, now.toISOString(), delivered);
    await this.patchJob(job.id, {
      status: 'done',
      nextRunAt: undefined,
      lastError: reason,
    }).catch(() => {});
  }

  /**
   * A run that threw is a FAILED run (UBP-004): `lastError` holds the reason,
   * `runCount` is not bumped, and a job with no later occurrence (a one-shot)
   * is paused rather than left for the next tick to retire unrun — `resumeJob`
   * makes it due again. A prompt job with an origin also tells its chat, at
   * most once per `CRON_FAILURE_NOTICE_INTERVAL_MS` (UBP-029); script jobs
   * already deliver their own notice in `executeScriptJob`.
   */
  private async recordRunFailure(job: CronJob, err: unknown, noLaterRun: boolean): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(`[cron] Job "${job.id}" failed`, {
      component: 'cron',
      jobId: job.id,
      error: String(err),
    });
    const failurePatch: Partial<CronJob> = { lastError: message };
    const isPromptJob = !job.script && job.source !== 'system';
    const lastNotice = job.failureNoticeAt ? new Date(job.failureNoticeAt).getTime() : 0;
    if (isPromptJob && job.origin && Date.now() - lastNotice >= CRON_FAILURE_NOTICE_INTERVAL_MS) {
      const notice = `Cron job "${job.name}" failed: ${message.slice(0, 500)}`;
      // `deliverTo` writes its own `delivery failed` lastError on a refusal;
      // the patch below runs after it so the run's own failure is what stays.
      if (await this.deliverTo(job, notice))
        failurePatch.failureNoticeAt = new Date().toISOString();
    }
    if (noLaterRun) failurePatch.status = 'paused';
    await this.patchJob(job.id, failurePatch).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Context resolution (job chaining)
  // ---------------------------------------------------------------------------

  private async resolveContext(job: CronJob): Promise<string> {
    if (!job.contextFrom || job.contextFrom.length === 0) return '';

    const blocks: string[] = [];
    const jobs = await this.readJobs();
    const firesShared = this.runAudience(job, jobs) === 'shared';
    for (const ref of job.contextFrom) {
      // Only the firing job's own personality's output (S15). A reference
      // stored before `createJob` refused foreign ones resolves to nothing.
      const refJob = findOwnedRef(jobs, ref, job.personalityId);
      if (!refJob) {
        this.logger.warn(`[cron] contextFrom "${ref}" skipped for job "${job.id}"`, {
          component: 'cron',
          jobId: job.id,
          reason: `no job "${ref}" owned by personality "${job.personalityId}"`,
        });
        continue;
      }
      // A shared firing reads only output that was itself produced shared
      // (verification round E1): a private job's run may have read private
      // memory, and its output would otherwise land in the room.
      if (firesShared && this.runAudience(refJob, jobs) !== 'shared') {
        this.logger.warn(`[cron] contextFrom "${ref}" skipped for job "${job.id}"`, {
          component: 'cron',
          jobId: job.id,
          reason: `job "${refJob.id}" does not run shared; "${job.id}" does`,
        });
        continue;
      }

      const runs = await this.listRuns(refJob.id, 1);
      if (runs.length === 0) continue;

      const latestRun = runs[0];
      if (!latestRun) continue;
      try {
        const output = await this.readRunOutput(latestRun.outputPath);
        // A prior run's output is whatever that turn read (web pages, mail):
        // fenced as untrusted, like the precheck stdout below (plan
        // openclaw-2026.9.6-gaps S13; pinned by "fences each referenced output
        // as untrusted" in __tests__/cron.test.ts).
        const fenced = wrapUntrusted({
          content: output,
          toolName: 'cron_context',
          source: `cron-run:${refJob.id}`,
        }).content;
        blocks.push(
          `--- Context from "${refJob.name}" (${refJob.id}) ---\n${fenced}\n--- End context ---`,
        );
      } catch {
        // non-fatal — skip this reference
      }
    }

    return blocks.length > 0 ? `${blocks.join('\n\n')}\n\n` : '';
  }

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  /**
   * Run one job and always release its mid-execution stamp.
   *
   * The `finally` is the load-bearing half: a job that THROWS (script failure,
   * a dead LLM provider, a missing systemTask handler) must not leave
   * `runningSince` set, or the idle watcher would read this deployment as
   * permanently busy and never suspend again.
   */
  private async executeJob(job: CronJob, runningStamp?: number): Promise<CronRunResult> {
    // Set only when a turn outlived its `maxRunMs`: the run is abandoned, but
    // the turn may still be executing, so the stamp must outlive the race
    // (UBP-026) — it is released when that promise settles, not now.
    let abandoned: Promise<unknown> | undefined;
    try {
      return await this.runExecution(job, (turn) => {
        abandoned = turn;
      });
    } finally {
      if (runningStamp !== undefined) {
        const release = () => this.clearRunning(job.id, runningStamp).catch(() => {});
        if (abandoned) void abandoned.then(release, release);
        else await release();
      }
    }
  }

  private async runExecution(
    job: CronJob,
    onAbandoned: (turn: Promise<unknown>) => void,
  ): Promise<CronRunResult> {
    // System jobs dispatch to a registered handler instead of the LLM runJob path
    if (job.source === 'system' && job.systemTask) {
      const handler = this.systemTasks[job.systemTask];
      if (!handler) {
        throw new Error(
          `System task handler "${job.systemTask}" not registered for job "${job.id}"`,
        );
      }
      const { output } = await handler(job);
      const ranAt = new Date().toISOString();
      await this.persistAndDeliver(job, output, ranAt);
      return { jobId: job.id, ranAt, output, sessionKey: `cron:system:${job.id}` };
    }

    // Script jobs run an operator-authored script file — zero LLM involvement.
    if (job.script) {
      return this.executeScriptJob(job, job.script);
    }

    // Precheck gate: a deterministic script decides whether the LLM turn runs
    // at all. Exit 78 skips the turn (zero tokens); exit 0 injects stdout as
    // untrusted context; any other outcome fails open (a broken check must
    // not mute a watchdog).
    let precheckContext = '';
    if (job.precheck) {
      const pre = await this.runScriptRef(job.precheck, 'precheck');
      if (pre.ok && pre.exitCode === PRECHECK_SKIP_EXIT_CODE) {
        const ranAt = new Date().toISOString();
        this.notifyDecision(job, { action: 'precheck-skip', output: '' }, ranAt, false);
        return { jobId: job.id, ranAt, output: '', sessionKey: `cron:precheck-skip:${job.id}` };
      }
      if (pre.ok && pre.exitCode === 0) {
        const stdout = pre.stdout.trim();
        if (stdout) {
          const wrapped = wrapUntrusted({
            content: stdout,
            toolName: 'cron_precheck',
            source: job.precheck.file,
          });
          precheckContext = `${wrapped.content}\n\n`;
        }
      } else {
        const reason =
          pre.failure ?? `precheck "${job.precheck.file}" exited with code ${pre.exitCode}`;
        this.logger.error(
          `[cron] Precheck failed for job "${job.id}" — running the turn without precheck context`,
          { component: 'cron', jobId: job.id, error: reason },
        );
      }
    }

    // The context prefix carries prior-run outputs (external content) — run the
    // whole effective prompt through the injection guard before the LLM sees it.
    const contextPrefix = await this.resolveContext(job);
    const effectivePrompt = sanitize(precheckContext + contextPrefix + (job.prompt ?? ''));
    const result = await this.runTurnCapped({ ...job, prompt: effectivePrompt }, onAbandoned);
    await this.persistAndDeliver(
      job,
      result.output,
      result.ranAt,
      result.progress,
      result.transcript,
    );
    return result;
  }

  /**
   * R10 — a prompt job's turn gets a wall-clock cap (`job.maxRunMs`, else
   * `defaultMaxRunMs`). At the cap the turn's `abortSignal` fires and the run
   * is abandoned with a "timed out" error even if `runJob` ignores the signal,
   * so a stalled turn cannot hold its `runningSince` stamp or a
   * `maxParallelJobs` slot. The throw lands in `lastError` like any failed run.
   */
  private async runTurnCapped(
    job: CronJob,
    onAbandoned: (turn: Promise<unknown>) => void,
  ): Promise<CronRunResult> {
    const maxRunMs = Math.min(job.maxRunMs ?? this.defaultMaxRunMs, MAX_CRON_RUN_MS);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const turn = this.runJob(job, { abortSignal: controller.signal });
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        // The turn ignored its signal and is still running: hand it to
        // `executeJob`, which keeps `runningSince` until it settles.
        onAbandoned(turn);
        reject(new Error(`Cron job "${job.id}" turn timed out after ${maxRunMs}ms (maxRunMs)`));
      }, maxRunMs);
    });
    try {
      return await Promise.race([turn, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // Script execution — through the injected ExecutionBackend, never raw
  // child_process. Path guards re-run at execution time.
  // ---------------------------------------------------------------------------

  /** Hermes-compatible script-job semantics: exit 0 + stdout → deliver
   *  verbatim; exit 0 + empty stdout → silent tick ('script-silent'); any
   *  failure → lastError + a delivered failure notice (never silent). */
  private async executeScriptJob(job: CronJob, script: ScriptRef): Promise<CronRunResult> {
    const ranAt = new Date().toISOString();
    const outcome = await this.runScriptRef(script);

    const failureReason = !outcome.ok
      ? (outcome.failure ?? `script "${script.file}" failed`)
      : outcome.exitCode !== 0
        ? `script "${script.file}" exited with code ${outcome.exitCode}${
            outcome.stderr.trim() ? `: ${outcome.stderr.trim().slice(0, 500)}` : ''
          }`
        : null;

    if (failureReason) {
      await this.persistRun(job, `[script failed] ${failureReason}`, ranAt);
      const notice = `Cron job "${job.name}" ${failureReason}`;
      const delivered = await this.deliverTo(job, notice);
      this.notifyDecision(job, { action: 'escalate', output: notice }, ranAt, delivered);
      // Throw so the tick's lastError handling stays uniform and runJobNow
      // surfaces the failure to its caller.
      throw new Error(failureReason);
    }

    const output = outcome.stdout.trimEnd();
    if (output.trim() === '') {
      // Silent tick — the script's contract replaces [SILENT] prompt discipline.
      await this.persistRun(job, '(no output)', ranAt);
      this.notifyDecision(job, { action: 'script-silent', output: '' }, ranAt, false);
      return { jobId: job.id, ranAt, output: '', sessionKey: `cron:script:${job.id}` };
    }

    // Non-empty stdout is delivered VERBATIM — no [SILENT] escalation gate.
    await this.persistRun(job, output, ranAt);
    const delivered = await this.deliverTo(job, output);
    this.notifyDecision(job, { action: 'escalate', output }, ranAt, delivered);
    return { jobId: job.id, ranAt, output, sessionKey: `cron:script:${job.id}` };
  }

  /** Create/update-time validation: path guards plus must-already-exist
   *  (an agent can schedule an operator-authored script but cannot
   *  write-then-schedule its own — plan §5.1c). */
  private async validateScriptRef(ref: ScriptRef, label: 'script' | 'precheck'): Promise<void> {
    const { absPath } = resolveScriptFile(ref, this.scriptsDir, label);
    if (!(await this.storage.exists(absPath))) {
      throw new Error(
        `${label} file not found: "${ref.file}" — scripts must already exist in ${this.scriptsDir}`,
      );
    }
  }

  /** Run a script through the execution backend — delegates to the shared
   *  `runScriptFile` (path guards, fixed interpreters, secret redaction). */
  private runScriptRef(
    ref: ScriptRef,
    label: 'script' | 'precheck' = 'script',
  ): Promise<ScriptRunOutcome> {
    return runScriptFile(ref, {
      storage: this.storage,
      executionBackend: this.getExecutionBackend(),
      scriptsDir: this.scriptsDir,
      label,
    });
  }

  private getExecutionBackend(): ExecutionBackend {
    if (!this.executionBackend) {
      // Standalone/test fallback — local execution; the ctx is ignored by
      // LocalExecutionBackend but required by the factory contract.
      this.executionBackend = new LocalExecutionBackend({
        config: {},
        secrets: noopSecrets,
        logger: this.logger,
      });
    }
    return this.executionBackend;
  }

  /** Deliver to the origin channel when configured; returns delivered flag. */
  private async deliverTo(job: CronJob, text: string): Promise<boolean> {
    if (!job.origin || !this.deliver) return false;
    try {
      await this.deliver(job, text);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[cron] Delivery failed for job "${job.id}"`, {
        component: 'cron',
        jobId: job.id,
        error: message,
      });
      // A run that produced output nobody received is a failed run from the
      // operator's side. Record it on the job so `ethos cron list` and the Cron
      // page say so — the run itself succeeded, so the tick's own lastError
      // path never fires and this would otherwise be visible only in the log.
      await this.patchJob(job.id, { lastError: `delivery failed: ${message}` }).catch(() => {});
      return false;
    }
  }

  /** Shared post-run path: persist run output to
   *  <cronDir>/output/<id>/<timestamp>.md, deliver to the originating
   *  channel per the escalation decision (silent outputs are audited and
   *  persisted but never delivered), and fire the heartbeat audit. */
  private async persistAndDeliver(
    job: CronJob,
    output: string,
    ranAt: string,
    progress?: CronRunProgress[],
    transcript?: string,
  ): Promise<void> {
    // The run file keeps the whole stream (narration included); only the
    // final answer is judged and delivered — see CronRunResult.transcript.
    await this.persistRun(job, transcript ?? output, ranAt, progress);

    // `output` is passed to `decideEscalation` and `deliverTo` EXACTLY as the
    // runner produced it. Progress never joins it — see CronRunResult.progress.
    // An empty output is never delivered (UBP-004): there is nothing to say,
    // and a platform refusing an empty message would read as a delivery fault.
    const decision: CronDecision =
      output.trim() === '' ? { action: 'silent', output } : decideEscalation(output);
    const delivered = decision.action === 'escalate' ? await this.deliverTo(job, output) : false;
    this.notifyDecision(job, decision, ranAt, delivered);
  }

  /** Write the run body to <cronDir>/output/<jobId>/<ts>.md, and any recorded
   *  progress to the sibling <ts>.progress.json. The sidecar is written only
   *  when there is progress, so a run that recorded none leaves exactly the
   *  files it always did. */
  private async persistRun(
    job: CronJob,
    output: string,
    ranAt: string,
    progress?: CronRunProgress[],
  ): Promise<void> {
    const ts = ranAt.replace(/[:.]/g, '-').replace('Z', 'Z');
    const outPath = join(this.outputDir, job.id, `${ts}.md`);
    await this.storage.mkdir(dirname(outPath));
    await this.storage.write(outPath, `# ${job.name}\n\n${output}\n`);
    if (progress && progress.length > 0) {
      await this.storage.write(progressPathFor(outPath), JSON.stringify(progress, null, 2));
    }
  }

  /** Heartbeat audit callback — fail-open, a throwing observer never breaks the run. */
  private notifyDecision(
    job: CronJob,
    decision: CronDecision,
    ranAt: string,
    delivered: boolean,
  ): void {
    if (!this.onDecision) return;
    try {
      this.onDecision(job, { ...decision, ranAt, delivered });
    } catch {
      // audit is fail-open
    }
  }

  // ---------------------------------------------------------------------------
  // Storage helpers
  // ---------------------------------------------------------------------------

  private async readJobs(): Promise<CronJob[]> {
    const raw = await this.storage.read(this.jobsPath);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as CronJob[];
    } catch {
      return [];
    }
  }

  private async writeJobs(jobs: CronJob[]): Promise<void> {
    await this.storage.mkdir(this.cronDir);
    // Atomic: a process killed mid-write must leave the previous jobs.json,
    // not a truncated one (a torn write reads back as `[]` — every job gone).
    await this.storage.writeAtomic(this.jobsPath, JSON.stringify(jobs, null, 2));
  }

  private async withJobsLock(fn: (jobs: CronJob[]) => Promise<CronJob[]>): Promise<void> {
    // The lock file lives next to jobs.json; the directory must exist
    // before the lock can be acquired the first time.
    await this.storage.mkdir(this.cronDir);
    // Stale-aware: a lock left by a killed process is reclaimed (jobs-lock.ts).
    await withJobsFileLock(this.lockPath, async () => {
      const jobs = await this.readJobs();
      const updated = await fn(jobs);
      await this.writeJobs(updated);
    });
  }

  private async patchJob(id: string, patch: Partial<CronJob>): Promise<void> {
    await this.withJobsLock(async (jobs) => {
      const idx = jobs.findIndex((j) => j.id === id);
      const existing = idx >= 0 ? jobs[idx] : undefined;
      if (!existing) throw new Error(`Job not found: ${id}`);
      jobs[idx] = { ...existing, ...patch };
      return jobs;
    });
  }

  /**
   * Real compare-and-swap for claiming a due job's execution slot. Unlike
   * `patchJob` (last-write-wins), this re-reads jobs FRESH inside
   * `withJobsLock` and only applies `patch` if `nextRunAt` still equals
   * `expectedNextRunAt` (the value the caller's `tick()` snapshotted before
   * the lock) and the job is still `active`. If another concurrent `tick()`
   * already claimed/advanced the job first, the check fails and this
   * returns `false` without writing anything — the caller should treat that
   * as "someone else already got it", not an error. Returns `true` iff this
   * call's claim was the one that stuck.
   */
  private async claimDueJob(
    jobId: string,
    expectedNextRunAt: string | undefined,
    patch: Partial<CronJob>,
  ): Promise<ClaimOutcome> {
    const outcome: { value: ClaimOutcome } = { value: { kind: 'lost' } };
    await this.withJobsLock(async (jobs) => {
      const idx = jobs.findIndex((j) => j.id === jobId);
      const existing = idx >= 0 ? jobs[idx] : undefined;
      if (!existing) throw new Error(`Job not found: ${jobId}`);
      if (existing.status !== 'active' || existing.nextRunAt !== expectedNextRunAt) {
        // Already claimed (or otherwise moved) by a concurrent tick — no-op.
        return jobs;
      }
      // UBP-026 — a fresh `runningSince` means the previous run of this job is
      // still executing (a long turn, a run-now, a timed-out turn that ignored
      // its abort). Refuse the claim; advance past the occurrence so the job
      // is not left due on every tick. A one-shot has no later occurrence and
      // stays due until its running copy finishes.
      if (typeof existing.runningSince === 'number' && this.isRunning(existing, Date.now())) {
        if (patch.nextRunAt !== undefined) jobs[idx] = { ...existing, nextRunAt: patch.nextRunAt };
        outcome.value = { kind: 'overlap', runningSince: existing.runningSince };
        return jobs;
      }
      jobs[idx] = { ...existing, ...patch };
      outcome.value = { kind: 'claimed' };
      return jobs;
    });
    return outcome.value;
  }

  /**
   * Release a mid-execution stamp — a compare-and-swap, not a blind write. It
   * clears `runningSince` only if the stored stamp is still the one THIS
   * execution wrote, so a concurrent claim (a `runJobNow` overlapping a tick,
   * say) that has already stamped a newer value is never clobbered back to
   * idle. Missing job, or someone else's stamp: no-op.
   */
  private async clearRunning(jobId: string, stamp: number): Promise<void> {
    await this.withJobsLock(async (jobs) => {
      const idx = jobs.findIndex((j) => j.id === jobId);
      const existing = idx >= 0 ? jobs[idx] : undefined;
      if (!existing || existing.runningSince !== stamp) return jobs;
      jobs[idx] = { ...existing, runningSince: null, runningOwner: null };
      return jobs;
    });
  }
}

/** This process, as the owner of a `runningSince` stamp. */
function runOwner(): CronRunOwner {
  return { pid: process.pid, boot: currentBootId(), token: PROCESS_RUN_TOKEN };
}

/**
 * Whether the owner of a `runningSince` stamp can still be running it. The
 * same liveness rule as the jobs lock (`jobs-lock.ts` `staleReason`, itself a
 * copy of `packages/wiring/src/backup/holder-identity.ts` `classifyHolder`,
 * which `extensions/` cannot import): a dead pid, or a pid from an earlier boot,
 * is gone. Added here: this pid under another process token is an earlier
 * process the pid was recycled to — typically this process's own predecessor
 * after a restart — so that is gone too. No owner: the stamp predates owners,
 * and such stamps never blocked a claim.
 */
function runOwnerAlive(owner: CronRunOwner | null | undefined): boolean {
  if (!owner) return false;
  if (owner.token === PROCESS_RUN_TOKEN) return true;
  if (owner.pid === process.pid) return false;
  const boot = currentBootId();
  if (owner.boot !== null && boot !== null && owner.boot !== boot) return false;
  return isPidAlive(owner.pid);
}

/** What `claimDueJob`'s compare-and-swap decided. */
type ClaimOutcome =
  | { kind: 'claimed' }
  /** A concurrent tick moved the job first. */
  | { kind: 'lost' }
  /** The job's previous run still holds a fresh `runningSince` stamp. */
  | { kind: 'overlap'; runningSince: number };

// ---------------------------------------------------------------------------
// Re-exports from heartbeat + schedule modules
// ---------------------------------------------------------------------------

export type { HeartbeatAction, HeartbeatDecision } from './heartbeat';
export { decideEscalation } from './heartbeat';
export type { ParsedSchedule } from './schedule';
export {
  isOneShotSchedule,
  isValidSchedule,
  nextRunForSchedule,
  parseSchedule,
} from './schedule';

// ---------------------------------------------------------------------------
// Re-exports from the trigger module (CronTriggerSource / CronArmingBackend)
// ---------------------------------------------------------------------------

export type {
  BuildCronTriggersOptions,
  CronDeploymentConfig,
  CronTriggerSource,
  CronTriggers,
} from './trigger';
export {
  buildCronTriggers,
  HttpFireTrigger,
  LocalIntervalTrigger,
  NoopArmingBackend,
} from './trigger';

// ---------------------------------------------------------------------------
// Backward-compat helpers — delegate to the new schedule parser
// ---------------------------------------------------------------------------

/** @deprecated Use `isValidSchedule` — this thin wrapper keeps existing callers working. */
export function isValidCronExpression(expr: string): boolean {
  return isValidSchedule(expr);
}

/** @deprecated Use `nextRunForSchedule` — this thin wrapper keeps existing callers working. */
export function nextRun(schedule: string): Date | null {
  return nextRunForSchedule(schedule, new Date()) ?? null;
}

/** @deprecated Use `nextRunForSchedule` — this thin wrapper keeps existing callers working. */
export function nextRunAfter(schedule: string, after: Date): Date | null {
  return nextRunForSchedule(schedule, after) ?? null;
}

/**
 * Reverse the timestamp encoding used by `executeJob` when persisting
 * output (`<ISO>.md` with `:` and `.` replaced by `-`). Returns the raw
 * stem if the filename doesn't match the expected pattern.
 */
function filenameToIso(filename: string): string {
  const stem = filename.replace(/\.md$/, '');
  const m = stem.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})(Z?)$/);
  if (!m) return stem;
  const [, date, hh, mm, ss, ms, z] = m;
  return `${date}T${hh}:${mm}:${ss}.${ms}${z ?? ''}`;
}

/**
 * A `contextFrom` reference (id or name) resolved among `personalityId`'s own
 * jobs only — the single lookup behind `createJob`'s refusal and
 * `resolveContext`'s fire-time re-check (S15). Pinned by the S15 cases in
 * `src/__tests__/cron.test.ts` ("CronScheduler job chaining").
 */
function findOwnedRef(
  jobs: readonly CronJob[],
  ref: string,
  personalityId: string,
): CronJob | undefined {
  return jobs.find((j) => (j.id === ref || j.name === ref) && j.personalityId === personalityId);
}

/**
 * `CronSchedulerConfig.runAudience`'s default: the stamps alone. Shared iff
 * the job, or any job its `contextFrom` names, is stamped `'shared'`. The
 * hosts pass the full rule (`cronRunAudience`, which also judges the delivery
 * target); this keeps a scheduler built without it from reading a private
 * job's output into a job stamped shared.
 */
function stampAudience(job: CronJob, jobs: readonly CronJob[]): TurnAudience {
  if (job.roomAudience === 'shared') return 'shared';
  for (const ref of job.contextFrom ?? []) {
    if (findOwnedRef(jobs, ref, job.personalityId)?.roomAudience === 'shared') return 'shared';
  }
  return 'private';
}

/**
 * The id `createJob` gives a job created by `name` alone. Exported so the
 * `cron` tool can refuse a name collision on a shared turn without naming the
 * job it collides with (`extensions/tools-cron`, verification round G5).
 */
export function jobIdForName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}
