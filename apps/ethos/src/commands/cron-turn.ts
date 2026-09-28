// One cron firing's agent turn: pick the session it runs in, then run it.
// Pure of the serve command's wiring (loop and session store are injected) so
// the routing rule and the failure path are unit-testable.

import type { PrivateChatSet } from '@ethosagent/core';
import { type CronJob, CronProgressRecorder, type CronRunProgress } from '@ethosagent/cron';
import {
  type AgentEvent,
  EthosError,
  type TurnAudience,
  type TurnInitiator,
  unstreamedAnswer,
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
  /** Read only to check a `webOrigin` session's personality binding — a host
   *  with no web surface (`ethos gateway`, `ethos cron run`) passes none. */
  sessions?: CronTurnSessions;
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
  /** The final answer only — the text after the turn's last tool call (or a
   *  `returnDirect` tool's answer). What cron delivers and what
   *  `decideEscalation` tests for a leading `[SILENT]` (UBP-025). */
  output: string;
  /** Everything the turn streamed, every iteration included, when that is
   *  more than `output` — `CronRunResult.transcript`, kept in the run file. */
  transcript?: string;
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
 * A stream that ends with no `done` (it died mid-answer) throws too, so a
 * truncated partial answer is never delivered as the complete one.
 *
 * The ONE cron turn implementation: `ethos serve`, `ethos boot`, `ethos gateway`
 * and `ethos cron run` all call it (UBP-004 — the gateway and CLI copies that
 * ignored `error` are gone).
 *
 * Output: only the final LLM iteration's text is the answer. Narration streamed
 * before a tool call ("Let me check the watchlist.") is kept in `transcript`
 * but never leads the delivered message, and never pushes a final `[SILENT]`
 * off position 0 (UBP-025).
 */
export async function runCronTurn(input: CronTurnInput): Promise<CronTurnResult> {
  const { loop, sessions, jobId, prompt, personalityId, toolsetOverride, abortSignal } = input;
  const webOrigin = input.webOrigin ?? null;

  const boundPersonalityId =
    webOrigin && sessions
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

  // `streamed` is the whole stream; `segment` restarts at every tool call, so
  // when the turn ends it holds the last iteration's text — the answer.
  let streamed = '';
  let segment = '';
  let doneText: string | undefined;
  let sawDone = false;
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
    if (event.type === 'text_delta') {
      streamed += event.text;
      segment += event.text;
    } else if (event.type === 'tool_start') segment = '';
    else if (event.type === 'done') {
      sawDone = true;
      doneText = event.text;
    } else if (event.type === 'error') failure = `[${event.code}] ${event.error}`;
    // Records only `audience: 'user'` events; the recorder is the gate.
    else progress.record(event);
  }
  if (!failure && !sawDone) failure = 'the turn ended without a final answer';
  if (failure) {
    throw new EthosError({
      code: 'CRON_RUN_FAILED',
      cause: `Cron job "${jobId}" turn failed: ${failure}`,
      action: `Run 'ethos cron list' to inspect the job, then check its personality and prompt.`,
    });
  }

  // A `returnDirect` tool's answer arrives only as `done.text` and never
  // streamed (`unstreamedAnswer`): it IS the final message, and anything that
  // streamed before it was preamble.
  const owed = unstreamedAnswer(streamed, doneText);
  const output = owed || segment;
  const transcript = owed ? (streamed.trim() ? `${streamed}\n\n${owed}` : owed) : streamed;
  return {
    sessionKey,
    output,
    ...(transcript !== output ? { transcript } : {}),
    reusedWebOrigin,
    progress: progress.snapshot(),
  };
}

/** The job fields a host's `runJob` reads. `CronJob` satisfies it. */
interface CronHostJob {
  id: string;
  prompt?: string;
  personalityId: string;
}

export interface CronRunJobDeps<J extends CronHostJob = CronHostJob> {
  /** The loop to fire on — built lazily by `ethos cron run`, forward-
   *  referenced by `ethos gateway`. Throws when it is not available. */
  loop: () => CronTurnLoop | Promise<CronTurnLoop>;
  /** The job personality's effective toolset, `cron` removed so a cron-spawned
   *  session cannot schedule more jobs. Called before `loop()`, so a host can
   *  refuse a job whose personality is gone without building a loop. */
  toolsetFor: (job: J) => Promise<string[] | undefined>;
  /** The firing's room audience — `cronFiringAudience` below, which reads the
   *  full `CronJob`. Required, so a host cannot forget it (plan
   *  personality-memory-boundary G1-9). */
  audienceFor: (job: J) => Promise<TurnAudience>;
}

/**
 * The `CronScheduler.runJob` for a host with no web surface — `ethos gateway`
 * and `ethos cron run`. A thin adapter onto {@link runCronTurn}, so those hosts
 * share the one turn implementation (its `error` → throw rule included) rather
 * than a copy of its loop (UBP-004). Pinned by
 * `apps/ethos/src/__tests__/cron-host-run-job.test.ts`.
 */
export function createCronRunJob<J extends CronHostJob>(deps: CronRunJobDeps<J>) {
  return async (
    job: J,
    runOpts?: { abortSignal: AbortSignal },
  ): Promise<{
    jobId: string;
    ranAt: string;
    output: string;
    sessionKey: string;
    transcript?: string;
    progress: CronRunProgress[];
  }> => {
    const toolsetOverride = await deps.toolsetFor(job);
    const roomAudience = await deps.audienceFor(job);
    const loop = await deps.loop();
    const { sessionKey, output, transcript, progress } = await runCronTurn({
      loop,
      jobId: job.id,
      prompt: job.prompt ?? '',
      personalityId: job.personalityId,
      ...(toolsetOverride ? { toolsetOverride } : {}),
      // R10 — the scheduler aborts this at the job's `maxRunMs`.
      ...(runOpts ? { abortSignal: runOpts.abortSignal } : {}),
      roomAudience,
    });
    return {
      jobId: job.id,
      ranAt: new Date().toISOString(),
      output,
      sessionKey,
      ...(transcript !== undefined ? { transcript } : {}),
      progress,
    };
  };
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
