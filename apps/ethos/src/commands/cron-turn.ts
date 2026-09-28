// One cron firing's agent turn: pick the session it runs in, then run it.
// Pure of the serve command's wiring (loop and session store are injected) so
// the routing rule and the failure path are unit-testable.

import type { PrivateChatSet } from '@ethosagent/core';
import { type CronJob, CronProgressRecorder, type CronRunProgress } from '@ethosagent/cron';
import {
  type AgentEvent,
  answerSuffix,
  EthosError,
  type TurnAudience,
  type TurnInitiator,
} from '@ethosagent/types';
import { cronRunAudience } from '@ethosagent/wiring';

/** The slice of `AgentLoop` a cron firing needs. */
interface CronTurnLoop {
  run(
    text: string,
    opts: {
      sessionKey: string;
      personalityId: string;
      toolsetOverride?: string[];
      abortSignal?: AbortSignal;
      roomAudience: TurnAudience;
      initiator: TurnInitiator;
    },
  ): AsyncIterable<AgentEvent>;
}

/** The slice of `SessionStore` a cron firing needs. */
interface CronTurnSessions {
  getSessionByKey(key: string): Promise<{ personalityId?: string } | null>;
}

export interface CronTurnInput {
  loop: CronTurnLoop;
  sessions: CronTurnSessions;
  jobId: string;
  prompt: string;
  personalityId: string;
  toolsetOverride?: string[];
  /** The originating web chat's session key, when the job was created from one. */
  webOrigin?: string | null;
  /** From the scheduler's `CronRunJobOptions`: aborted at the job's `maxRunMs`. */
  abortSignal?: AbortSignal;
  /** The firing's room audience — `cronFiringAudience` below. Required, so a
   *  runner cannot forget it (plan personality-memory-boundary G1-9). */
  roomAudience: TurnAudience;
}

export interface CronTurnResult {
  sessionKey: string;
  output: string;
  /** True when the turn ran in the originating web chat's session. */
  reusedWebOrigin: boolean;
  /** `audience: 'user'` tool progress observed during the turn, capped by
   *  `CronProgressRecorder`. Separate from `output` on purpose — see
   *  `CronRunResult.progress` in `@ethosagent/cron`. */
  progress: CronRunProgress[];
}

/**
 * Run a cron job's turn.
 *
 * Session routing: reuse the originating web chat's session key so the firing
 * lands in that chat's history and the client can reload to show it. That reuse
 * only holds while the job's personality IS the one the web session is bound
 * to — a session's personality is fixed at creation, so a mismatched turn is
 * refused with `personality_locked` and the firing would record nothing. On a
 * mismatch the job runs in its own `cron:<id>:<iso>` session instead. A web
 * session that does not exist yet, or that predates the binding rule, still
 * reuses the key: this turn binds it.
 *
 * Failure: a refused or errored turn emits `error` and no text. Throwing makes
 * the scheduler record `lastError` for the job, which is the same contract a
 * failed script job uses — silently persisting an empty output is not an option.
 */
export async function runCronTurn(input: CronTurnInput): Promise<CronTurnResult> {
  const { loop, sessions, jobId, prompt, personalityId, toolsetOverride, abortSignal } = input;
  const webOrigin = input.webOrigin ?? null;

  const boundPersonalityId = webOrigin
    ? ((await sessions.getSessionByKey(webOrigin))?.personalityId ?? null)
    : null;
  // A shared firing never runs in the owner's web chat: its first turn would
  // stamp that session shared for good (G1-7). It gets its own session.
  const reusedWebOrigin =
    input.roomAudience === 'private' &&
    webOrigin !== null &&
    (boundPersonalityId === null || boundPersonalityId === personalityId);
  const sessionKey =
    reusedWebOrigin && webOrigin !== null ? webOrigin : `cron:${jobId}:${new Date().toISOString()}`;

  let output = '';
  let failure: string | undefined;
  const progress = new CronProgressRecorder();
  for await (const event of loop.run(prompt, {
    sessionKey,
    personalityId,
    ...(toolsetOverride ? { toolsetOverride } : {}),
    ...(abortSignal ? { abortSignal } : {}),
    roomAudience: input.roomAudience,
    initiator: 'system',
  })) {
    if (event.type === 'text_delta') output += event.text;
    // A `returnDirect` tool's answer arrives only as `done.text`, after any
    // preamble that streamed: `answerSuffix` is what the stream still owes.
    else if (event.type === 'done') output += answerSuffix(output, event.text);
    else if (event.type === 'error') failure = `[${event.code}] ${event.error}`;
    // Records only `audience: 'user'` events; the recorder is the gate.
    else progress.record(event);
  }
  if (failure) {
    throw new EthosError({
      code: 'CRON_RUN_FAILED',
      cause: `Cron job "${jobId}" turn failed: ${failure}`,
      action: `Run 'ethos cron list' to inspect the job, then check its personality and prompt.`,
    });
  }

  return { sessionKey, output, reusedWebOrigin, progress: progress.snapshot() };
}

/**
 * The room audience one cron firing runs under: `cronRunAudience`
 * (packages/wiring/src/cron-audience.ts) over the job, every job in
 * `jobs.json` (for `contextFrom`) and the operator's trusted rooms. An
 * unstamped job that resolves shared is logged once per firing (D11) with the
 * way back. Shared by all three cron runners — `ethos gateway start`, `ethos
 * serve`/`ethos boot` (through `runCronTurn`) and `ethos cron run` — and pinned
 * by `apps/ethos/src/__tests__/cron-audience-run.test.ts`.
 */
export async function cronFiringAudience(
  job: CronJob,
  deps: {
    listJobs: () => Promise<CronJob[]>;
    privateChats?: PrivateChatSet;
    warn: (line: string) => void;
  },
): Promise<TurnAudience> {
  const jobs = job.contextFrom && job.contextFrom.length > 0 ? await deps.listJobs() : [];
  return cronRunAudience(job, {
    jobs,
    ...(deps.privateChats ? { privateChats: deps.privateChats } : {}),
    onUnstamped: (legacy) => {
      const target = legacy.origin ? ` (delivers to ${legacy.origin.platform})` : '';
      deps.warn(
        `[cron] job "${legacy.id}"${target} predates room-audience stamps and runs without ` +
          `private memory. To restore it, list its chat in gateway.private_chats.<platform> ` +
          `and restart, or recreate the job from a DM or the CLI/web app.`,
      );
    },
  });
}

/**
 * `CronSchedulerConfig.runAudience` for every host that builds a
 * `CronScheduler`: the same `cronRunAudience` rule as `cronFiringAudience`
 * above, over the jobs `resolveContext` already read, so the scheduler's
 * fire-time `contextFrom` check (verification round E1) and the turn's
 * audience agree. No unstamped-job warning here — the runner logs it once per
 * firing. Pinned by `apps/ethos/src/__tests__/cron-audience-run.test.ts`.
 */
export function cronContextAudience(
  privateChats?: PrivateChatSet,
): (job: CronJob, jobs: readonly CronJob[]) => TurnAudience {
  return (job, jobs) => cronRunAudience(job, { jobs, ...(privateChats ? { privateChats } : {}) });
}
