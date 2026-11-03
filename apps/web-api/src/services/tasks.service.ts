import type {
  BackgroundJob,
  BackgroundJobEvent,
  JobRunner,
  JobRunnerRegistry,
  JobSteer,
  JobStore,
} from '@ethosagent/types';
import type {
  BackgroundJobDetailWire,
  BackgroundJobEventWire,
  BackgroundJobSummaryWire,
  JobSteerWire,
} from '@ethosagent/web-contracts';
import type { CreateAgentLoopResult } from '@ethosagent/wiring';

/** Typed off wiring's result so web-api needs no workspace dep on job-runner. */
type JobControl = NonNullable<CreateAgentLoopResult['jobControl']>;
type SteerOutcome = Awaited<ReturnType<JobControl['steer']>>;
export type TasksSteerResult =
  | { ok: true; steerId: number }
  | Extract<SteerOutcome, { ok: false }>
  | { ok: false; reason: 'not_available' };
export type TasksEventsResult =
  | { ok: true; events: BackgroundJobEventWire[] }
  | { ok: false; reason: 'not_found' | 'not_available' };
export type TasksCancelResult = { ok: boolean };

/** How many of a job's newest events one detail read returns. */
const DETAIL_EVENT_LIMIT = 200;

export interface TasksServiceOptions {
  /** The durable background-job store from wiring's CreateAgentLoopResult.
   *  Absent when background delegation is disabled — every read degrades to
   *  an empty result and `cancel` reports `{ ok: false }` rather than throwing. */
  store?: JobStore;
  /**
   * Resolved runners, consulted on `get` so the run card's detail grid can carry
   * the runner's OWN rows alongside the 12 the UI owns (pi-delegation D18).
   * Absent, or a row naming a runner this process did not resolve → no extra
   * rows and no capabilities, which is still a valid card (T28).
   */
  runners?: JobRunnerRegistry;
  /**
   * The steer/stop/tail seam from wiring (`CreateAgentLoopResult.jobControl`).
   * Absent → `steer` and `events` report `not_available`, `get` falls back to
   * the resolved runner for `capabilities`, and `cancel` writes the cancel
   * request directly. Every call here is a web-console call, so the requester
   * audience is `'private'`.
   */
  control?: JobControl;
}

// Maps the domain `BackgroundJob` (camelCase, epoch-ms numbers, optional fields
// possibly `undefined`) onto the wire schema, which uses `.nullable()` — absent
// optionals become explicit `null`, never omitted. Mirrors how GoalsService
// hands rows to the goals RPC.
function toSummary(job: BackgroundJob): BackgroundJobSummaryWire {
  return {
    id: job.id,
    status: job.status,
    label: job.label ?? null,
    personalityId: job.personalityId ?? null,
    spendUsd: job.spendUsd,
    maxCostUsd: job.maxCostUsd ?? null,
    depth: job.depth,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    heartbeatAt: job.heartbeatAt ?? null,
    owner: job.owner,
    rootSessionKey: job.rootSessionKey,
    parentSessionKey: job.parentSessionKey,
    runner: job.runner ?? null,
  };
}

function toEvent(event: BackgroundJobEvent): BackgroundJobEventWire {
  return {
    id: event.id,
    jobId: event.jobId,
    seq: event.seq,
    eventType: event.eventType,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}

function toSteer(steer: JobSteer): JobSteerWire {
  return {
    id: steer.id,
    jobId: steer.jobId,
    text: steer.text,
    state: steer.state,
    source: steer.source,
    requesterUserId: steer.requesterUserId ?? null,
    createdAt: steer.createdAt,
    readAt: steer.readAt ?? null,
  };
}

function toDetail(
  job: BackgroundJob,
  events: BackgroundJobEvent[],
  runner: JobRunner | undefined,
  capabilities: JobRunner['capabilities'] | null,
  steers: JobSteer[],
): BackgroundJobDetailWire {
  return {
    ...toSummary(job),
    prompt: job.prompt,
    summary: job.summary ?? null,
    error: job.error ?? null,
    events: events.map(toEvent),
    childSessionKey: job.childSessionKey,
    originPlatform: job.originPlatform ?? null,
    originChatId: job.originChatId ?? null,
    blockedRequestId: job.blockedRequestId ?? null,
    // A runner throwing while describing a row must not take the detail read
    // down with it — the 12 shared rows are still worth rendering.
    detailRows: describeSafely(runner, job),
    capabilities: capabilities ? toCapabilities(capabilities) : null,
    steers: steers.map(toSteer),
  };
}

function toCapabilities(
  caps: JobRunner['capabilities'],
): NonNullable<BackgroundJobDetailWire['capabilities']> {
  // The contract's arrays are `readonly`; the wire schema's are not. Copying is
  // the whole conversion — the alternative is a schema that lets a surface
  // mutate a runner's advertised capabilities in place.
  return {
    interactionKinds: [...caps.interactionKinds],
    answerScopes: [...caps.answerScopes],
    takeover: caps.takeover,
    resume: caps.resume,
    steer: caps.steer,
    sandbox: caps.sandbox,
    transport: caps.transport,
  };
}

function describeSafely(
  runner: JobRunner | undefined,
  job: BackgroundJob,
): BackgroundJobDetailWire['detailRows'] {
  if (!runner) return [];
  try {
    return runner.describe(job).map((row) => ({
      label: row.label,
      value: row.value,
      ...(row.tone ? { tone: row.tone } : {}),
    }));
  } catch {
    return [];
  }
}

export class TasksService {
  private store?: JobStore;
  private runners?: JobRunnerRegistry;
  private control?: JobControl;

  constructor(opts: TasksServiceOptions) {
    this.store = opts.store;
    this.runners = opts.runners;
    this.control = opts.control;
  }

  /**
   * Background jobs scoped to a single root session. The frozen `JobStore`
   * contract exposes `listByRoot` but no `listAll`, so a global cross-session
   * list is not available without a schema change (Phase A contract). When
   * `rootSessionKey` is omitted, we return `[]` rather than adding a method to
   * the frozen contract — the Tasks page scopes to one session at a time.
   */
  async list(rootSessionKey?: string): Promise<BackgroundJobSummaryWire[]> {
    if (!this.store || !rootSessionKey) return [];
    const jobs = await this.store.listByRoot(rootSessionKey);
    return jobs.map(toSummary);
  }

  async get(id: string): Promise<BackgroundJobDetailWire | null> {
    if (!this.store) return null;
    const job = await this.store.get(id);
    if (!job) return null;
    // Bounded tail: the newest N rows, not the whole trail. A long run's event
    // log is unbounded, and this read happens at the exact moment someone opens
    // a task to find out what went wrong — the worst moment to buffer it all.
    const events = await this.store.getEvents(id, { limit: DETAIL_EVENT_LIMIT });
    // A row naming a runner this process did not resolve still renders: the 12
    // shared rows are the UI's contract, the runner's are a bonus (D18/T28).
    const runner = job.runner ? this.runners?.get(job.runner) : undefined;
    // With a control seam, capabilities come from it so a default-runner row
    // (no `job.runner`) still reports the Ethos runner's truth instead of null.
    const capabilities = this.control
      ? this.control.capabilitiesFor(job)
      : (runner?.capabilities ?? null);
    const steers = this.control
      ? await this.control.steers(job)
      : ((await this.store.listSteers?.(id)) ?? []);
    return toDetail(job, events, runner, capabilities, steers);
  }

  async cancel(id: string): Promise<TasksCancelResult> {
    if (!this.store) return { ok: false };
    if (!this.control) {
      await this.store.requestCancel(id);
      return { ok: true };
    }
    const job = await this.store.get(id);
    if (!job) return { ok: false };
    const res = await this.control.stop(job, { requesterAudience: 'private' });
    return { ok: res.ok };
  }

  async steer(id: string, text: string): Promise<TasksSteerResult> {
    if (!this.store || !this.control) return { ok: false, reason: 'not_available' };
    const job = await this.store.get(id);
    if (!job) return { ok: false, reason: 'not_found' };
    return this.control.steer(job, { text, source: 'web', requesterAudience: 'private' });
  }

  /** Rows with `seq > afterSeq`, oldest first — the Tasks page's transcript cursor. */
  async events(id: string, afterSeq?: number, limit?: number): Promise<TasksEventsResult> {
    if (!this.store) return { ok: false, reason: 'not_available' };
    const job = await this.store.get(id);
    if (!job) return { ok: false, reason: 'not_found' };
    if (!this.control) {
      const rows = await this.store.getEvents(id, {
        ...(afterSeq !== undefined ? { afterSeq } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return { ok: true, events: rows.map(toEvent) };
    }
    const res = await this.control.tail(job, {
      requesterAudience: 'private',
      audience: 'operator',
      ...(afterSeq !== undefined ? { afterSeq } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return res.ok ? { ok: true, events: res.events.map(toEvent) } : res;
  }
}
