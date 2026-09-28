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
// And two more since UBP-024 / UBP-029 (plan/phases/upstream-bug-parity.md):
//
//  3. A channel delivery goes out AS THE JOB'S BOT (`JobOrigin.botKey`), never
//     through the platform's first adapter — with two Telegram bots, SalesBot's
//     job must not be sent by SupportBot. A job created before `botKey` was
//     recorded delivers only when the platform has exactly one bot.
//     A job created in a thread or forum topic (`JobOrigin.threadId`) goes
//     back into that thread, not the chat root.
//  4. It goes through the delivery ledger (`Gateway.notifyTracked` →
//     `sendTracked`; both hosts wire `GatewayConfig.deliveryLedger`), so a send
//     the platform refuses stays `pending` and `Gateway.startDeliverySweep`
//     retries it, instead of being lost with a `lastError`. The ledger half is
//     pinned by the gateway's own `__tests__/notify-tracked.test.ts`; this
//     module's half (bot + tracked path) by `__tests__/cron-deliver.test.ts`.
//
// Two copies is what let the second one drift. This module is the only one.

import { EthosError } from '@ethosagent/types';

/** The job fields delivery reads. Structural on purpose: `CronJob` satisfies
 *  it, and a test does not have to build one. */
export interface CronDeliverJob {
  personalityId: string;
  /** Channel origin captured at create time; absent means file-only. A
   *  `threadId` (UBP-024) sends the output back into that thread or topic. */
  origin?: { platform: string; chatId: string; botKey?: string; threadId?: string };
}

/** "Does any configured bot on `platform` still speak for `personalityId`?" —
 *  `buildChannelSpeakers` in `apps/ethos/src/commands/gateway.ts`. */
export type ChannelSpeakers = (platform: string, personalityId: string) => boolean;

export interface CronDeliverDeps {
  /** Structural: `Gateway`. */
  gateway: {
    /** Used only for a `web` origin, which has no bot and no ledger lane. */
    sendTo(
      platform: string,
      target: string,
      body: string,
    ): Promise<{ ok: boolean; error?: string }>;
    /** The ledger-backed, bot-addressed send (`Gateway.notifyTracked`). */
    notifyTracked(
      target: { platform: string; chatId: string; botKey?: string; threadId?: string },
      text: string,
    ): Promise<boolean | 'held'>;
    /** Every live adapter; ids are `<platform>:<botKey>` (or a bare platform
     *  in a single-bot deployment). Read only to resolve a legacy job's bot. */
    listAdapters(): ReadonlyArray<{ id: string }>;
  };
  speaksFor: ChannelSpeakers;
}

/**
 * The bot a job created before `JobOrigin.botKey` existed delivers as: the
 * platform's ONLY bot, or a refusal. `undefined` means "the deployment's single
 * default bot" (`Gateway.notifyTracked` resolves it), for an adapter id that
 * carries no botKey segment.
 */
function legacyBotKey(
  adapters: ReadonlyArray<{ id: string }>,
  platform: string,
  personalityId: string,
): string | undefined {
  const ids = [
    ...new Set(
      adapters.map((a) => a.id).filter((id) => id === platform || id.startsWith(`${platform}:`)),
    ),
  ];
  const only = ids[0];
  if (only === undefined || ids.length > 1) {
    throw new EthosError({
      code: 'CRON_TARGET_NOT_ALLOWED',
      cause:
        only === undefined
          ? `no ${platform} bot is running here — output was not delivered`
          : `this job records no bot and ${ids.length} ${platform} bots are configured — output was not delivered rather than sent by the wrong one`,
      action: `Recreate the job from a chat with the ${platform} bot bound to "${personalityId}" so it records which bot to use.`,
    });
  }
  const colon = only.indexOf(':');
  return colon > 0 ? only.slice(colon + 1) : undefined;
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
    const { platform, chatId, threadId } = job.origin;
    if (platform === 'web') {
      const result = await deps.gateway.sendTo(platform, chatId, output);
      if (!result.ok) {
        throw new EthosError({
          code: 'NETWORK_ERROR',
          cause: result.error ?? 'web delivery failed',
          action: 'Check that the originating web session still exists.',
        });
      }
      return;
    }
    if (!deps.speaksFor(platform, job.personalityId)) {
      throw new EthosError({
        code: 'CRON_TARGET_NOT_ALLOWED',
        cause: `no ${platform} bot is bound to personality "${job.personalityId}" — output was not delivered`,
        action: `Re-add a ${platform} bot bound to "${job.personalityId}", or point the job somewhere else.`,
      });
    }
    const botKey =
      job.origin.botKey ?? legacyBotKey(deps.gateway.listAdapters(), platform, job.personalityId);
    const sent = await deps.gateway.notifyTracked(
      {
        platform,
        chatId,
        ...(botKey !== undefined ? { botKey } : {}),
        ...(threadId ? { threadId } : {}),
      },
      output,
    );
    // `'held'` is owed, not failed: quiet hours or a lane mute, released later.
    if (sent === false) {
      throw new EthosError({
        code: 'NETWORK_ERROR',
        cause: `${platform} did not confirm delivery${botKey ? ` via bot "${botKey}"` : ''}`,
        action:
          'If the delivery ledger recorded it, the gateway delivery sweep retries it; otherwise check that the bot is configured here and the chat is reachable.',
      });
    }
  };
}
