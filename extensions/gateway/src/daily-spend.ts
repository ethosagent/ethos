// Per-bot daily spend cap (`bots.<id>.budget.dailyUsd`): the cached UTC-day
// spend read, the reply-side cap check and the background-job usage gate.
// Moved out of index.ts (Context Budget 3, Task 2). `Gateway` constructs one
// `DailySpend` and keeps a delegating method under each name it still calls
// (`Gateway.backgroundGate` is public).
//
// It owns no state: the per-day spend cache (`dailySpend`) stays a `Gateway`
// field, reached by reference through `deps`.

import { buildLaneKey } from '@ethosagent/core';
import type { PlatformAdapter, UsageGateRequest, UsageGateVerdict } from '@ethosagent/types';
import type {
  BotSpend,
  GatewayBotConfig,
  GatewayConfig,
  GatewayObservability,
} from './gateway-config';
import { DAILY_SPEND_REFRESH_MS, platformOfAdapterId, utcDayStart } from './gateway-pure';

/** What `DailySpend` reads and calls on `Gateway`: live getters (and setters for
 *  the fields it writes) over `Gateway`-owned state, closures for its methods. */
export interface DailySpendDeps {
  readonly adapterRegistry: Map<string, PlatformAdapter>;
  readonly botAdapters: Map<string, PlatformAdapter>;
  readonly botSpendSince: GatewayConfig['botSpendSince'];
  readonly bots: Map<string, GatewayBotConfig>;
  readonly dailySpend: Map<string, { day: string; spend: BotSpend; readAt: number }>;
  readonly defaultBotKey: string | null;
  readonly observability: GatewayObservability | undefined;
}

export class DailySpend {
  constructor(private readonly deps: DailySpendDeps) {}

  /** Cache key and session-key prefix for one bot's daily spend: its lanes are
   *  all `buildLaneKey(platform, botKey, …)`, and so are their sessions. */
  dailySpendKey(bot: GatewayBotConfig, platform: string): string {
    return `${buildLaneKey(platform, bot.botKey)}:`;
  }

  /**
   * The bot's spend since 00:00 UTC, or `null` when no daily cap applies (no
   * `budget`, no `botSpendSince`) or the read failed. See
   * `DAILY_SPEND_REFRESH_MS` for when the store is read. Fail-open on a read
   * that throws — recorded as `gateway.daily_budget_unreadable` — because a
   * cap that cannot be read refusing every turn would take the bot down over a
   * locked database; the next turn tries the read again.
   */
  async spentToday(bot: GatewayBotConfig, platform: string): Promise<BotSpend | null> {
    const read = this.deps.botSpendSince;
    if (!bot.budget || !read) return null;
    const now = Date.now();
    const start = utcDayStart(now);
    const day = start.toISOString().slice(0, 10);
    const key = this.dailySpendKey(bot, platform);
    const cached = this.deps.dailySpend.get(key);
    if (cached && cached.day === day && now - cached.readAt < DAILY_SPEND_REFRESH_MS) {
      return cached.spend;
    }
    try {
      const spend = await read({ sessionKeyPrefix: key, botKey: bot.botKey }, start);
      this.deps.dailySpend.set(key, { day, spend, readAt: now });
      return spend;
    } catch (err) {
      this.deps.observability?.recordSafetyBlock({
        code: 'gateway.daily_budget_unreadable',
        cause: err instanceof Error ? err.message : String(err),
        details: { platform, botKey: bot.botKey },
      });
      return null;
    }
  }

  /** Fold a `usage` event from this process's own turn into the cached figure.
   *  A turn's `usage` events carry its main calls and its utility charges, both
   *  reply spend. */
  addDailySpend(bot: GatewayBotConfig, platform: string, usd: number): void {
    if (!bot.budget || !Number.isFinite(usd) || usd <= 0) return;
    const cached = this.deps.dailySpend.get(this.dailySpendKey(bot, platform));
    if (cached && cached.day === utcDayStart(Date.now()).toISOString().slice(0, 10)) {
      cached.spend = { ...cached.spend, repliesUsd: cached.spend.repliesUsd + usd };
    }
  }

  /**
   * `{ spentUsd, capUsd }` when today's spend meets the bot's daily cap, else
   * null — the REPLY gate. Counts reply spend; background spend only with
   * `budget.backgroundBlocksReplies` (D14). Pinned by the background-spend
   * cases in `__tests__/budget-halt.test.ts`.
   */
  async dailyCapReached(
    bot: GatewayBotConfig,
    platform: string,
  ): Promise<{ spentUsd: number; capUsd: number } | null> {
    if (!bot.budget) return null;
    const capUsd = bot.budget.dailyUsd;
    const spend = await this.spentToday(bot, platform);
    if (spend === null) return null;
    const spentUsd =
      spend.repliesUsd + (bot.budget.backgroundBlocksReplies ? spend.backgroundUsd : 0);
    return spentUsd >= capUsd ? { spentUsd, capUsd } : null;
  }

  /**
   * The BACKGROUND gate (background-usage-accounting §7.2): `skip` once the
   * bot's whole spend today (replies and background) meets its
   * `budget.dailyUsd`, else `allow`. Asked by the usage meter before a bot
   * loop's `background` call (`MeteredProvider`'s `gate`, which never asks for
   * `GATE_EXEMPT_KINDS`; bound late by `gatewayTurnOrigin` in
   * apps/ethos/src/commands/gateway.ts) and by the channel digest before each
   * lane. The caller records a skip (`usage.background_skipped`).
   *
   * `allow` whenever no cap applies or the figure cannot be had: no bot with
   * that key (the system loop's rows carry none), no `budget`, no platform to
   * read the bot's lanes under, or an unreadable store (recorded by
   * `spentToday`). Pinned by `__tests__/budget-halt.test.ts`.
   */
  async backgroundGate(request: UsageGateRequest): Promise<UsageGateVerdict> {
    const { botKey } = request.attribution;
    const bot = botKey !== undefined ? this.deps.bots.get(botKey) : undefined;
    if (!bot?.budget) return { decision: 'allow' };
    const capUsd = bot.budget.dailyUsd;
    const platform = this.platformOfBot(bot.botKey, request.attribution);
    if (!platform) return { decision: 'allow' };
    const spend = await this.spentToday(bot, platform);
    if (spend === null) return { decision: 'allow' };
    const spentUsd = spend.repliesUsd + spend.backgroundUsd;
    return spentUsd >= capUsd ? { decision: 'skip', spentUsd, capUsd } : { decision: 'allow' };
  }

  /** The platform whose lanes hold a bot's sessions, for a call that may not
   *  say: the call's own platform, else the bot's own adapter's, else — the
   *  single-bot alias `adapterForBot` applies — the one platform this process
   *  serves. */
  platformOfBot(botKey: string, attribution: UsageGateRequest['attribution']): string | undefined {
    if (attribution.platform) return attribution.platform;
    const own = this.deps.botAdapters.get(botKey);
    if (own) return platformOfAdapterId(own.id);
    if (botKey === this.deps.defaultBotKey && this.deps.adapterRegistry.size === 1) {
      return [...this.deps.adapterRegistry.keys()][0];
    }
    return undefined;
  }
}
