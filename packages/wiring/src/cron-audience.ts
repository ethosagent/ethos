// The room audience a cron firing runs under (plan
// personality-memory-boundary-and-self-amendment G1-6, D11). One rule, shared
// by every cron runner — `ethos gateway start`'s system loop, `runCronTurn`
// (`ethos serve`, `ethos boot`) and `ethos cron run` — so the three cannot
// drift. Pinned by `packages/wiring/src/__tests__/cron-audience.test.ts`.

import { type PrivateChatSet, targetAudience } from '@ethosagent/core';
import type { CronJob } from '@ethosagent/cron';
import type { TurnAudience } from '@ethosagent/types';

export interface CronRunAudienceOptions {
  /**
   * Every job in `jobs.json`, for resolving `contextFrom`. Absent or missing a
   * reference → that reference is skipped, the same as `resolveContext` in
   * @ethosagent/cron, which then reads no output from it either.
   */
  jobs?: readonly CronJob[];
  /** `gateway.private_chats` (`privateChatSetFrom`); a listed delivery target is private. */
  privateChats?: PrivateChatSet;
  /**
   * Called for each consulted job that carries no `roomAudience` stamp
   * (written before the field existed) and runs shared because of its
   * delivery target. The caller logs it (D11): the way back is to list that
   * chat in `gateway.private_chats.<platform>` and restart, or to recreate the
   * job from a DM or the CLI/web app.
   */
  onUnstamped?: (job: CronJob) => void;
}

/**
 * `'shared'` if ANY of these says shared — shared only ever narrows:
 *   - the job's own stamp (`CronJob.roomAudience`, written at creation);
 *   - its delivery target (`CronJob.origin`) is not provably one-to-one
 *     (`targetAudience`, packages/core/src/chat-audience.ts, honouring
 *     `privateChats`) — a DM-created job that posts to a group is shared, and
 *     a Discord or email target, which cannot be classified, fails closed;
 *   - any job its `contextFrom` names (among the same personality's jobs, as
 *     `resolveContext` resolves them) is shared by this same rule, since that
 *     job's output is read into the prompt.
 * `'private'` otherwise. An unstamped (pre-upgrade) job is therefore judged by
 * its delivery target alone, the plan's legacy rule (D11): a channel target
 * that is not provably private runs shared; a job with no target at all
 * (created from the CLI, file-only) runs private.
 */
export function cronRunAudience(job: CronJob, opts: CronRunAudienceOptions = {}): TurnAudience {
  return isShared(job, opts, new Set()) ? 'shared' : 'private';
}

function isShared(job: CronJob, opts: CronRunAudienceOptions, seen: Set<string>): boolean {
  if (seen.has(job.id)) return false;
  seen.add(job.id);
  if (job.roomAudience === 'shared') return true;
  if (
    job.origin &&
    targetAudience(job.origin.platform, job.origin.chatId, opts.privateChats) === 'shared'
  ) {
    if (job.roomAudience === undefined) opts.onUnstamped?.(job);
    return true;
  }
  for (const ref of job.contextFrom ?? []) {
    const refJob = opts.jobs?.find(
      (j) => (j.id === ref || j.name === ref) && j.personalityId === job.personalityId,
    );
    if (refJob && isShared(refJob, opts, seen)) return true;
  }
  return false;
}
