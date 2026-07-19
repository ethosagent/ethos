import { spawn } from 'node:child_process';
import { open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { noopLogger } from '@ethosagent/logger';
import { sanitize } from '@ethosagent/safety-injection';
import type { Logger, Storage } from '@ethosagent/types';
import { decideEscalation, type HeartbeatDecision } from './heartbeat';
import { isOneShotSchedule, isValidSchedule, nextRunForSchedule } from './schedule';

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
}

export interface CronJob {
  id: string;
  name: string;
  /** Schedule expression: 5-field cron, relative delay (30m), interval (every 2h), or ISO timestamp. */
  schedule: string;
  /** Prompt the agent will run. Optional for source:'system' jobs (they use systemTask handlers). */
  prompt?: string;
  /** Operator-authored shell command executed with zero LLM involvement.
   *  Channel/LLM text is never interpolated into it (plan R3). Mutually
   *  exclusive with `prompt`; not allowed on source:'system' jobs. */
  script?: string;
  personalityId: string;
  /** Channel origin captured at create time; absent means file-only. */
  origin?: JobOrigin;
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
  /** Ownership. 'system' jobs are seeded by the framework and non-disableable.
   *  Default 'user'. Distinct from `origin` (channel platform/chatId). */
  source?: 'system' | 'user';
  /** For source:'system' — the registered system-task handler name. Present iff source==='system'. */
  systemTask?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
}

export type CronJobUpdate = Partial<Pick<CronJob, 'name' | 'schedule' | 'prompt'>>;

export interface CronRunResult {
  jobId: string;
  ranAt: string;
  output: string;
  sessionKey: string;
}

export interface CronRunInfo {
  /** ISO-8601 timestamp parsed from the run output filename. */
  ranAt: string;
  /** Absolute path to the persisted markdown output. */
  outputPath: string;
}

export interface CronSchedulerConfig {
  /** Called when a job fires. Returns the text output and session key. */
  runJob: (job: CronJob) => Promise<CronRunResult>;
  /** Directory for jobs.json and output files. Defaults to ~/.ethos/cron/ */
  cronDir?: string;
  /** Tick interval in ms. Default 60_000 (1 min). */
  tickIntervalMs?: number;
  /** Storage backend. Injected by the composition root; required — never
   *  falls back to raw disk. */
  storage: Storage;
  /** Logger for tick-time errors. Defaults to a silent NoopLogger. */
  logger?: Logger;
  /** Optional callback to deliver run output back to the originating channel. */
  deliver?: (job: CronJob, output: string) => Promise<void>;
  /** source:'system' jobs dispatch here by systemTask name instead of runJob. */
  systemTasks?: Record<string, (job: CronJob) => Promise<{ output: string }>>;
  /** Fired after every executed run with the escalate-vs-silent decision — the heartbeat audit record. Failures are swallowed (audit is fail-open, never breaks the run). */
  onDecision?: (
    job: CronJob,
    decision: HeartbeatDecision & { ranAt: string; delivered: boolean },
  ) => void;
}

// ---------------------------------------------------------------------------
// File lock — uses raw `node:fs/promises` because exclusive create (`wx`)
// is a multi-process synchronization primitive that does not fit the data
// layer; same carve-out as SQLite/error-log per plan/storage_abstraction.md.
// ---------------------------------------------------------------------------

async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  let lockFd: Awaited<ReturnType<typeof open>> | null = null;
  const start = Date.now();

  while (Date.now() - start < 5_000) {
    try {
      lockFd = await open(lockPath, 'wx'); // exclusive create — atomic
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100)); // wait and retry
    }
  }

  if (!lockFd) throw new Error(`Could not acquire lock: ${lockPath}`);

  try {
    return await fn();
  } finally {
    await lockFd.close();
    await unlink(lockPath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Script runner — zero-LLM `script:` jobs. Uses raw `node:child_process`
// (process spawning is not a Storage concern).
// ---------------------------------------------------------------------------

const SCRIPT_TIMEOUT_MS = 30_000;

interface ScriptResult {
  /** Combined stdout + stderr. */
  output: string;
  exitCode: number;
  timedOut: boolean;
}

function runScript(command: string, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<ScriptResult> {
  return new Promise((resolvePromise) => {
    const child = spawn('sh', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    let output = '';
    let settled = false;
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      resolvePromise({ output: `${output}${String(err)}`, exitCode: 1, timedOut: false });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolvePromise({
        output,
        exitCode: typeof code === 'number' ? code : 1,
        timedOut: signal !== null,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// CronScheduler
// ---------------------------------------------------------------------------

export class CronScheduler {
  private readonly cronDir: string;
  private readonly jobsPath: string;
  private readonly lockPath: string;
  private readonly outputDir: string;
  private readonly runJob: (job: CronJob) => Promise<CronRunResult>;
  private readonly tickIntervalMs: number;
  private readonly storage: Storage;
  private readonly logger: Logger;
  private readonly deliver?: (job: CronJob, output: string) => Promise<void>;
  private readonly systemTasks: Record<string, (job: CronJob) => Promise<{ output: string }>>;
  private readonly onDecision?: (
    job: CronJob,
    decision: HeartbeatDecision & { ranAt: string; delivered: boolean },
  ) => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: CronSchedulerConfig) {
    this.cronDir = config.cronDir ?? join(homedir(), '.ethos', 'cron');
    this.jobsPath = join(this.cronDir, 'jobs.json');
    this.lockPath = join(this.cronDir, 'jobs.json.lock');
    this.outputDir = join(this.cronDir, 'output');
    this.runJob = config.runJob;
    this.tickIntervalMs = config.tickIntervalMs ?? 60_000;
    this.storage = config.storage;
    this.logger = config.logger ?? noopLogger;
    this.deliver = config.deliver;
    this.systemTasks = config.systemTasks ?? {};
    this.onDecision = config.onDecision;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    void this.tick(); // check immediately on start (handles missed runs)
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Job management (used by tools-cron and CLI)
  // ---------------------------------------------------------------------------

  async createJob(
    params: Omit<CronJob, 'id' | 'createdAt' | 'nextRunAt' | 'status' | 'runCount' | 'repeat'> & {
      repeat?: RepeatPolicy;
    },
  ): Promise<CronJob> {
    if (!params.personalityId) {
      throw new Error('personalityId is required');
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

    // prompt is required for user jobs unless a script is set; system jobs use systemTask
    if (params.source !== 'system' && !params.prompt && !params.script) {
      throw new Error('prompt is required for user jobs');
    }

    const now = new Date();
    const repeat: RepeatPolicy =
      params.repeat ??
      (isOneShotSchedule(params.schedule) ? { kind: 'once' } : { kind: 'forever' });

    const job: CronJob = {
      ...params,
      id: slugify(params.name),
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
        for (const ref of job.contextFrom) {
          if (!jobs.find((j) => j.id === ref || j.name === ref)) {
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
    await this.patchJob(id, {
      status: 'active',
      nextRunAt: nextRunForSchedule(
        job.schedule,
        new Date(),
        new Date(job.createdAt),
      )?.toISOString(),
    });
  }

  async updateJob(id: string, patch: CronJobUpdate): Promise<CronJob> {
    if (!patch.name && !patch.schedule && !patch.prompt) {
      throw new Error('At least one of name, schedule, or prompt is required');
    }

    let updatedJob: CronJob | undefined;

    await this.withJobsLock(async (jobs) => {
      const idx = jobs.findIndex((j) => j.id === id);
      const existing = idx >= 0 ? jobs[idx] : undefined;
      if (!existing) throw new Error(`Job not found: ${id}`);

      if (patch.schedule) {
        if (!isValidSchedule(patch.schedule)) {
          throw new Error(`Invalid schedule: "${patch.schedule}"`);
        }
        const nextAt = nextRunForSchedule(patch.schedule, new Date(), new Date(existing.createdAt));
        existing.schedule = patch.schedule;
        existing.nextRunAt = nextAt?.toISOString();
        // Recompute repeat if schedule changed to one-shot and repeat was forever
        if (isOneShotSchedule(patch.schedule) && existing.repeat.kind === 'forever') {
          existing.repeat = { kind: 'once' };
        }
      }
      if (patch.name !== undefined) existing.name = patch.name;
      if (patch.prompt !== undefined) existing.prompt = patch.prompt;

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
    return this.executeJob(job);
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
    const id = slugify(params.name);
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
    return names
      .filter((n) => n.endsWith('.md'))
      .map((name) => ({
        ranAt: filenameToIso(name),
        outputPath: join(dir, name),
      }))
      .sort((a, b) => (a.ranAt < b.ranAt ? 1 : -1))
      .slice(0, limit);
  }

  /** Read the full output body for a single run. */
  async readRunOutput(outputPath: string): Promise<string> {
    const rel = relative(this.outputDir, resolve(outputPath));
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Path outside output directory: ${outputPath}`);
    }
    const out = await this.storage.read(outputPath);
    if (out === null) throw new Error(`Run output not found: ${outputPath}`);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Tick — called every minute
  // ---------------------------------------------------------------------------

  private async tick(): Promise<void> {
    const now = new Date();
    const jobs = await this.readJobs();

    for (const job of jobs) {
      if (job.status !== 'active') continue;

      // Bug 3 fix: active job with no nextRunAt — try to recompute it.
      if (!job.nextRunAt) {
        const upcoming = nextRunForSchedule(job.schedule, now, new Date(job.createdAt));
        if (upcoming) {
          await this.patchJob(job.id, { nextRunAt: upcoming.toISOString() }).catch(() => {});
        } else {
          // One-shot schedule has fully elapsed — retire the job.
          await this.patchJob(job.id, { status: 'done' }).catch(() => {});
        }
        continue;
      }

      const due = new Date(job.nextRunAt);
      if (now < due) continue;

      // Bug 1+2 fix: only apply skip policy when the job is genuinely overdue
      // (server was down for more than one full tick interval). A job that fired
      // within the normal tick window is not "missed" — execute it.
      const missedByMs = now.getTime() - due.getTime();
      if (job.missedRunPolicy === 'skip' && missedByMs > this.tickIntervalMs) {
        const upcoming = nextRunForSchedule(job.schedule, now, new Date(job.createdAt));
        if (upcoming) {
          await this.patchJob(job.id, { nextRunAt: upcoming.toISOString() }).catch(() => {});
        } else {
          await this.patchJob(job.id, { status: 'done' }).catch(() => {});
        }
        continue;
      }

      // Claim the job by advancing nextRunAt BEFORE executing so a crash
      // mid-run doesn't double-fire on the next tick.
      const upcoming = nextRunForSchedule(job.schedule, now, new Date(job.createdAt));
      try {
        await this.patchJob(job.id, {
          lastRunAt: now.toISOString(),
          nextRunAt: upcoming?.toISOString(),
        });
      } catch (err) {
        this.logger.error(`[cron] Could not claim job "${job.id}", skipping tick`, {
          component: 'cron',
          jobId: job.id,
          error: String(err),
        });
        continue;
      }

      try {
        await this.executeJob(job);
      } catch (err) {
        this.logger.error(`[cron] Job "${job.id}" failed`, {
          component: 'cron',
          jobId: job.id,
          error: String(err),
        });
        await this.patchJob(job.id, {
          lastError: err instanceof Error ? err.message : String(err),
        }).catch(() => {});
        continue;
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
  }

  // ---------------------------------------------------------------------------
  // Context resolution (job chaining)
  // ---------------------------------------------------------------------------

  private async resolveContext(job: CronJob): Promise<string> {
    if (!job.contextFrom || job.contextFrom.length === 0) return '';

    const blocks: string[] = [];
    for (const ref of job.contextFrom) {
      const refJob = await this.findJobByIdOrName(ref);
      if (!refJob) continue;

      const runs = await this.listRuns(refJob.id, 1);
      if (runs.length === 0) continue;

      const latestRun = runs[0];
      if (!latestRun) continue;
      try {
        const output = await this.readRunOutput(latestRun.outputPath);
        blocks.push(
          `--- Context from "${refJob.name}" (${refJob.id}) ---\n${output}\n--- End context ---`,
        );
      } catch {
        // non-fatal — skip this reference
      }
    }

    return blocks.length > 0 ? `${blocks.join('\n\n')}\n\n` : '';
  }

  private async findJobByIdOrName(ref: string): Promise<CronJob | null> {
    const jobs = await this.readJobs();
    return jobs.find((j) => j.id === ref || j.name === ref) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  private async executeJob(job: CronJob): Promise<CronRunResult> {
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

    // Script jobs run an operator-authored shell command — zero LLM involvement.
    // Failures throw so the tick's lastError/retry handling stays uniform.
    if (job.script) {
      const result = await runScript(job.script);
      const ranAt = new Date().toISOString();
      if (result.timedOut) {
        throw new Error(`Script timed out after ${SCRIPT_TIMEOUT_MS}ms`);
      }
      if (result.exitCode !== 0) {
        throw new Error(
          `Script exited with code ${result.exitCode}: ${result.output.trim().slice(0, 500)}`,
        );
      }
      const output = result.output.trimEnd() || '(no output)';
      await this.persistAndDeliver(job, output, ranAt);
      return { jobId: job.id, ranAt, output, sessionKey: `cron:script:${job.id}` };
    }

    // The context prefix carries prior-run outputs (external content) — run the
    // whole effective prompt through the injection guard before the LLM sees it.
    const contextPrefix = await this.resolveContext(job);
    const effectivePrompt = sanitize(contextPrefix + (job.prompt ?? ''));
    const result = await this.runJob({ ...job, prompt: effectivePrompt });
    await this.persistAndDeliver(job, result.output, result.ranAt);
    return result;
  }

  /** Shared post-run path: persist run output to
   *  ~/.ethos/cron/output/<id>/<timestamp>.md, deliver to the originating
   *  channel per the escalation decision (silent outputs are audited and
   *  persisted but never delivered), and fire the heartbeat audit. */
  private async persistAndDeliver(job: CronJob, output: string, ranAt: string): Promise<void> {
    const ts = ranAt.replace(/[:.]/g, '-').replace('Z', 'Z');
    const outPath = join(this.outputDir, job.id, `${ts}.md`);
    await this.storage.mkdir(dirname(outPath));
    await this.storage.write(outPath, `# ${job.name}\n\n${output}\n`);

    const decision = decideEscalation(output);
    let delivered = false;
    if (job.origin && this.deliver && decision.action === 'escalate') {
      try {
        await this.deliver(job, output);
        delivered = true;
      } catch (err) {
        this.logger.error(`[cron] Delivery failed for job "${job.id}"`, {
          component: 'cron',
          jobId: job.id,
          error: String(err),
        });
      }
    }
    this.notifyDecision(job, decision, ranAt, delivered);
  }

  /** Heartbeat audit callback — fail-open, a throwing observer never breaks the run. */
  private notifyDecision(
    job: CronJob,
    decision: HeartbeatDecision,
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
    await this.storage.write(this.jobsPath, JSON.stringify(jobs, null, 2));
  }

  private async withJobsLock(fn: (jobs: CronJob[]) => Promise<CronJob[]>): Promise<void> {
    // The lock file lives next to jobs.json; the directory must exist
    // before the lock can be acquired the first time.
    await this.storage.mkdir(this.cronDir);
    await withLock(this.lockPath, async () => {
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
}

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

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}
