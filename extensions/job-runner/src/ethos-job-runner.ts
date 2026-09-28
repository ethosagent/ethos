import { type AgentLoop, targetAudience } from '@ethosagent/core';
import type {
  AgentEvent,
  BackgroundJob,
  DetailRow,
  JobRunner,
  JobRunnerContext,
  RunnerCapabilities,
  TurnAudience,
} from '@ethosagent/types';
import { SUMMARY_INSTRUCTION } from './summary';

/** The name the executor and `delegate_task` treat as the default runner. */
export const ETHOS_RUNNER_NAME = 'ethos';

/**
 * Capabilities of an in-process Ethos child turn.
 *
 * No takeover (there is no foreign process to attach to), no resume (the child
 * turn is not restartable from a persisted harness log), steering rides the
 * existing SteerSink, and containment is the in-process `ScopedFs` / toolset
 * allowlist rather than a sandbox.
 */
const ETHOS_CAPABILITIES: RunnerCapabilities = {
  interactionKinds: ['input', 'pick'],
  answerScopes: ['once'],
  takeover: 'none',
  resume: 'none',
  steer: true,
  sandbox: 'process',
  transport: 'in-process',
};

/**
 * The audience a background child runs under (plan personality-memory-boundary
 * G1-6). A stamped row (`BackgroundJob.roomAudience`) runs as stamped. An
 * unstamped row — written before the column existed (D11) — resolves from its
 * origin chat: a channel origin is judged by `targetAudience` (a provably
 * one-to-one chat is private, everything else, Discord and email included, is
 * shared); no origin at all (CLI, web, ACP) is private. Trusted rooms
 * (`gateway.private_chats`) are not consulted here, so a legacy job from a
 * listed group still runs shared — fail closed. Pinned by
 * `__tests__/room-audience.test.ts`.
 */
export function jobRoomAudience(
  job: Pick<BackgroundJob, 'roomAudience' | 'originPlatform' | 'originChatId'>,
): TurnAudience {
  if (job.roomAudience !== undefined) return job.roomAudience;
  if (job.originPlatform === undefined) return 'private';
  return targetAudience(job.originPlatform, job.originChatId ?? '');
}

/**
 * The default runner: the AgentLoop path the executor used to call inline.
 *
 * Behaviour-identical by construction — it builds the same child prompt and
 * passes the same run options, with `ctx.signal` standing in for the direct
 * AbortController reference. Everything the executor did with the resulting
 * events (text persistence, audit rows, spend, terminal transition) stayed in
 * the executor, because none of it is runner-specific.
 */
export class EthosJobRunner implements JobRunner {
  readonly name = ETHOS_RUNNER_NAME;
  readonly capabilities = ETHOS_CAPABILITIES;

  constructor(private readonly loop: AgentLoop) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  describe(_job: BackgroundJob): DetailRow[] {
    return [{ label: 'transport', value: ETHOS_CAPABILITIES.transport }];
  }

  run(job: BackgroundJob, ctx: JobRunnerContext): AsyncIterable<AgentEvent> {
    // Background jobs always run in summary mode — the parent re-ingests only a
    // bounded digest, so append the summary instruction to the child prompt.
    const childPrompt = job.prompt + SUMMARY_INSTRUCTION;
    return this.loop.run(childPrompt, {
      sessionKey: job.childSessionKey,
      ...(job.personalityId ? { personalityId: job.personalityId } : {}),
      agentId: `depth:${job.depth}`,
      rootSessionKey: job.rootSessionKey,
      jobId: job.id,
      abortSignal: ctx.signal,
      // A turn a shared turn causes is shared (G1-6). No `initiator`: children
      // never inherit it.
      roomAudience: jobRoomAudience(job),
      // The spawning turn's narrowing (S12), so the child never regains a
      // tool the parent turn was narrowed out of.
      ...(job.toolsetNarrowing?.narrow ? { toolsetNarrow: job.toolsetNarrowing.narrow } : {}),
      ...(job.toolsetNarrowing?.exclude ? { toolsetExclude: job.toolsetNarrowing.exclude } : {}),
    });
  }
}
