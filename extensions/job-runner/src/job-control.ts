import type {
  BackgroundJob,
  BackgroundJobEvent,
  BackgroundJobStatus,
  JobRunnerRegistry,
  JobSteer,
  JobSteerSource,
  JobStore,
  RunnerCapabilities,
  TurnAudience,
} from '@ethosagent/types';
import { ETHOS_RUNNER_CAPABILITIES, ETHOS_RUNNER_NAME, jobRoomAudience } from './ethos-job-runner';
import { isActiveJob } from './job-ref';

const CHANNEL_TAIL_LIMIT = 10;
const OPERATOR_TAIL_LIMIT = 50;
const CHANNEL_OVERFETCH = 5;
const CHANNEL_MIN_FETCH = 50;
const CHANNEL_HIDDEN_EVENTS: ReadonlySet<string> = new Set(['runner_log', 'artifact_change']);

export type SteerOutcome =
  | { ok: true; steerId: number }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'finished'
        | 'remote'
        | 'unsupported'
        | 'full'
        | 'too_long'
        | 'not_available';
      status?: BackgroundJobStatus;
    };

export type StopOutcome =
  | { ok: true; wasRunning: true }
  | { ok: false; reason: 'not_found' | 'finished' | 'remote'; status?: BackgroundJobStatus };

export type TailOutcome =
  | { ok: true; events: BackgroundJobEvent[] }
  | { ok: false; reason: 'not_found' | 'not_available' };

export interface JobControl {
  capabilitiesFor(job: BackgroundJob): RunnerCapabilities | null;
  steer(
    job: BackgroundJob,
    req: {
      text: string;
      source: JobSteerSource;
      requesterAudience: TurnAudience;
      requesterUserId?: string;
    },
  ): Promise<SteerOutcome>;
  stop(job: BackgroundJob, req: { requesterAudience: TurnAudience }): Promise<StopOutcome>;
  tail(
    job: BackgroundJob,
    req: {
      requesterAudience: TurnAudience;
      audience: 'channel' | 'operator';
      afterSeq?: number;
      limit?: number;
    },
  ): Promise<TailOutcome>;
  steers(job: BackgroundJob): Promise<JobSteer[]>;
}

export interface JobControlDeps {
  store: JobStore;
  runners?: JobRunnerRegistry;
  /** Same-process fast path: run the owner's observe pass now. */
  executor?: { pokeSteer(jobId: string): void };
}

/**
 * D11 — one audience gate for steer, stop and tail. A shared-room requester
 * may act only on a job that itself runs shared; a private requester may act
 * on any job. A refusal is reported as `not_found` so a room cannot probe for
 * private jobs. A job's audience is fixed when its run starts
 * (`jobRoomAudience`), so steering never widens it.
 */
export function jobActionAllowed(job: BackgroundJob, requesterAudience: TurnAudience): boolean {
  if (requesterAudience !== 'shared') return true;
  return jobRoomAudience(job) === 'shared';
}

export function createJobControl(deps: JobControlDeps): JobControl {
  const { store, runners, executor } = deps;

  const capabilitiesFor = (job: BackgroundJob): RunnerCapabilities | null => {
    if (!job.runner || job.runner === ETHOS_RUNNER_NAME) return ETHOS_RUNNER_CAPABILITIES;
    return runners?.get(job.runner)?.capabilities ?? null;
  };

  /** The stored row when readable, else the caller's copy: status moves under a long-held row. */
  const fresh = async (job: BackgroundJob): Promise<BackgroundJob> =>
    (await store.get(job.id)) ?? job;

  return {
    capabilitiesFor,

    async steer(job, req) {
      if (!jobActionAllowed(job, req.requesterAudience)) return { ok: false, reason: 'not_found' };
      if (!capabilitiesFor(job)?.steer) return { ok: false, reason: 'unsupported' };
      if (!store.addSteer) return { ok: false, reason: 'not_available' };
      const res = await store.addSteer(job.id, {
        text: req.text,
        source: req.source,
        ...(req.requesterUserId !== undefined ? { requesterUserId: req.requesterUserId } : {}),
      });
      if (!res.ok) {
        return { ok: false, reason: res.reason, ...(res.status ? { status: res.status } : {}) };
      }
      executor?.pokeSteer(job.id);
      return { ok: true, steerId: res.steer.id };
    },

    async stop(job, req) {
      if (!jobActionAllowed(job, req.requesterAudience)) return { ok: false, reason: 'not_found' };
      const row = await fresh(job);
      if (row.remoteJobId !== undefined) return { ok: false, reason: 'remote' };
      if (!isActiveJob(row)) return { ok: false, reason: 'finished', status: row.status };
      await store.requestCancel(job.id);
      executor?.pokeSteer(job.id);
      return { ok: true, wasRunning: true };
    },

    async tail(job, req) {
      if (!jobActionAllowed(job, req.requesterAudience)) return { ok: false, reason: 'not_found' };
      const limit =
        req.limit ?? (req.audience === 'channel' ? CHANNEL_TAIL_LIMIT : OPERATOR_TAIL_LIMIT);
      // The hidden-event filter runs after the store's `limit`, so the channel
      // path over-fetches, filters, then trims: newest `limit` without a cursor,
      // oldest `limit` after one (the store pages forward from `afterSeq`).
      const channel = req.audience === 'channel';
      const fetchLimit = channel ? Math.max(limit * CHANNEL_OVERFETCH, CHANNEL_MIN_FETCH) : limit;
      const events = await store.getEvents(
        job.id,
        req.afterSeq !== undefined
          ? { afterSeq: req.afterSeq, limit: fetchLimit }
          : { limit: fetchLimit },
      );
      if (!channel) return { ok: true, events };
      const visible = events.filter((e) => !CHANNEL_HIDDEN_EVENTS.has(e.eventType));
      return {
        ok: true,
        events: req.afterSeq !== undefined ? visible.slice(0, limit) : visible.slice(-limit),
      };
    },

    async steers(job) {
      return (await store.listSteers?.(job.id)) ?? [];
    },
  };
}
