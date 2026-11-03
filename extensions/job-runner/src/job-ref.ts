import {
  type BackgroundJob,
  type BackgroundJobStatus,
  JOB_STEER_MAX_CHARS,
  JOB_STEER_MAX_PENDING,
  type JobSteer,
} from '@ethosagent/types';
import type { SteerOutcome, StopOutcome } from './job-control';

/** A full UUID or a hex prefix of at least 8 chars (plan background-job-steer D13). Anything else is a prompt. */
export const JOB_REF_SHAPE = /^[0-9a-f]{8}[0-9a-f-]{0,28}$/i;

export const isJobRef = (token: string): boolean => JOB_REF_SHAPE.test(token);

const ACTIVE_STATUSES: ReadonlySet<BackgroundJobStatus> = new Set(['queued', 'running', 'blocked']);

/** True while the job can still be stopped or steered (not terminal). */
export const isActiveJob = (job: Pick<BackgroundJob, 'status'>): boolean =>
  ACTIVE_STATUSES.has(job.status);

export type JobRefResolution =
  | { kind: 'job'; job: BackgroundJob }
  | { kind: 'none' }
  | { kind: 'ambiguous'; ids: string[] };

/** Pure exact-id-then-unique-prefix match over jobs the caller already scoped. `ids` are full ids. */
export function resolveJobRef(jobs: readonly BackgroundJob[], ref: string): JobRefResolution {
  const needle = ref.toLowerCase();
  const exact = jobs.find((j) => j.id.toLowerCase() === needle);
  if (exact) return { kind: 'job', job: exact };
  const hits = jobs.filter((j) => j.id.toLowerCase().startsWith(needle));
  const [only] = hits;
  if (hits.length === 1 && only) return { kind: 'job', job: only };
  if (hits.length === 0) return { kind: 'none' };
  return { kind: 'ambiguous', ids: hits.map((j) => j.id) };
}

const short = (id: string): string => id.slice(0, 8);

const finishedText = (job: BackgroundJob, status: BackgroundJobStatus | undefined): string =>
  `job ${short(job.id)} already finished${status ? ` (${status})` : ''}`;

/** Refusal wording for a steer, shared by every surface. Surfaces word `not_found` themselves ("in this chat"/"in this session"); the text here is only a fallback. */
export function steerRefusalText(
  job: BackgroundJob,
  outcome: Extract<SteerOutcome, { ok: false }>,
): string {
  const id = short(job.id);
  switch (outcome.reason) {
    case 'not_found':
      return `no job ${id}`;
    case 'unsupported':
      return `job ${id} runs on ${job.runner ?? 'ethos'}, which can't take steers — /background stop ${id} to stop it`;
    case 'full':
      return `job ${id} already has ${JOB_STEER_MAX_PENDING} unread steers — wait for it to catch up`;
    case 'finished':
      return finishedText(job, outcome.status);
    case 'remote':
      return `job ${id} runs on another machine — it can't be steered from here`;
    case 'too_long':
      return `✗ That steer is too long (max ${JOB_STEER_MAX_CHARS} characters).`;
    case 'not_available':
      return '✗ Job steering is not available here.';
  }
}

/** Refusal wording for a stop, shared by every surface (surfaces word `not_found` themselves; fallback here). */
export function stopRefusalText(
  job: BackgroundJob,
  outcome: Extract<StopOutcome, { ok: false }>,
): string {
  switch (outcome.reason) {
    case 'not_found':
      return `no job ${short(job.id)}`;
    case 'remote':
      return `job ${short(job.id)} runs on another machine — it can't be stopped from here`;
    case 'finished':
      return finishedText(job, outcome.status);
  }
}

/** The steers a completion notice shows: first `lines`, each flattened and cut to `chars`, plus the overflow count. */
export function unreadSteerPreview(
  unread: readonly JobSteer[],
  opts: { lines: number; chars: number },
): { shown: string[]; more: number } {
  const shown = unread.slice(0, opts.lines).map((s) => {
    const flat = s.text.replace(/\s+/g, ' ').trim();
    return flat.length > opts.chars ? `${flat.slice(0, opts.chars - 1)}…` : flat;
  });
  return { shown, more: unread.length - shown.length };
}
