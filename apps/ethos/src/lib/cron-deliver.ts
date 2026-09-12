// B-T5 (plan/phases/trust-before-reach.md) — the ONE cron delivery path.
//
// A cron job with a channel origin routes its output back to the chat it was
// created from. Two things have to be true for that to be safe, and both were
// stated only on `ethos gateway start`'s copy while `ethos boot`'s copy did
// neither:
//
//  1. The bot must still speak for the job's personality. `Gateway.sendTo`
//     resolves an adapter by PLATFORM, so a job whose bot was removed from
//     config would otherwise deliver through whichever adapter is registered
//     for that platform — another agent's bot, answering in its voice, from a
//     schedule its operator never created (plan/phases/recipes-gallery.md §1).
//  2. A failed send must THROW. `CronScheduler.deliverTo` records `lastError`
//     from a rejected promise and from nothing else, so a swallowed failure is
//     a run that produced output nobody received and nothing on the job says
//     so — not `ethos cron list`, not the Cron page.
//
// Two copies is what let the second one drift. This module is the only one.

import { EthosError } from '@ethosagent/types';

/** The job fields delivery reads. Structural on purpose: `CronJob` satisfies
 *  it, and a test does not have to build one. */
export interface CronDeliverJob {
  personalityId: string;
  /** Channel origin captured at create time; absent means file-only. */
  origin?: { platform: string; chatId: string };
}

/** "Does any configured bot on `platform` still speak for `personalityId`?" —
 *  `buildChannelSpeakers` in `apps/ethos/src/commands/gateway.ts`. */
export type ChannelSpeakers = (platform: string, personalityId: string) => boolean;

export interface CronDeliverDeps {
  /** Structural: `Gateway`. */
  gateway: {
    sendTo(
      platform: string,
      target: string,
      body: string,
    ): Promise<{ ok: boolean; error?: string }>;
  };
  speaksFor: ChannelSpeakers;
}

/**
 * The `deliver` callback both gateway-role commands hand `CronScheduler`.
 *
 * A job with no origin delivers nothing — it is file-only, and its output is
 * already persisted under `~/.ethos/cron/output/`. A `web` origin is not a
 * channel and has no bot to bind: it replays into the originating web session,
 * so the binding check does not apply to it.
 */
export function createCronDeliver(
  deps: CronDeliverDeps,
): (job: CronDeliverJob, output: string) => Promise<void> {
  return async (job, output) => {
    if (!job.origin) return;
    const { platform, chatId } = job.origin;
    if (platform !== 'web' && !deps.speaksFor(platform, job.personalityId)) {
      throw new EthosError({
        code: 'CRON_TARGET_NOT_ALLOWED',
        cause: `no ${platform} bot is bound to personality "${job.personalityId}" — output was not delivered`,
        action: `Re-add a ${platform} bot bound to "${job.personalityId}", or point the job somewhere else.`,
      });
    }
    const result = await deps.gateway.sendTo(platform, chatId, output);
    if (!result.ok) {
      throw new EthosError({
        code: 'NETWORK_ERROR',
        cause: result.error ?? `${platform} delivery failed`,
        action: 'Check the bot credentials and that the chat is still reachable.',
      });
    }
  };
}
