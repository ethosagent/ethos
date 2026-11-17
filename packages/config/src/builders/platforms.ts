import { isOneOf, quotedList, sortedIndexes } from './utils';

/**
 * Per-bot routing binding. The bot's external identity (@handle, OAuth app)
 * is fixed to one destination — either a single personality or a team's
 * coordinator. `/personality` switching inside the bot's chats is disabled
 * by default; flip `allowSlashSwitch` only for the rare flexible bot.
 */
export interface BotBinding {
  type: 'personality' | 'team';
  name: string;
  allowSlashSwitch?: boolean;
}

export interface TelegramBotConfig {
  /** Stable identifier used in lane keys + logs. Defaults to a short
   *  sha256 of `token` when omitted. */
  id?: string;
  token: string;
  bind: BotBinding;
  piiRedaction?: boolean;
  /**
   * Channel mode for group chats with no per-chat override. Absent = the
   * adapter's own default (`mention_only`).
   *
   * The five values are `TelegramAdapterConfig`'s own enum
   * (`extensions/platform-telegram/src/config.ts`), not a shared list: Slack
   * has no `regex_match`, so the two unions are deliberately different
   * lengths. `observe` records the chat and never replies in it — not even to
   * an explicit @mention.
   */
  defaultChannelMode?: 'mention_only' | 'thread_follow' | 'all' | 'regex_match' | 'observe';
  /**
   * Receive updates over an inbound webhook instead of long-polling.
   * Default `false` — long-poll, exactly today's behaviour.
   *
   * The four fields below mirror `TelegramAdapterConfig`'s already-implemented
   * field names 1:1 (`extensions/platform-telegram/src/index.ts`) on purpose:
   * they are passed straight through at the one construction site, with no
   * translation layer (plan/phases/telegram-slack-webhook-mode.md §2a).
   */
  useWebhook?: boolean;
  /**
   * Full public URL Telegram POSTs updates to — INCLUDING the
   * `/telegram/webhook/<botKey>` path segment, since the host server routes
   * on that path in multi-bot deployments (§7, §8). Required when
   * `useWebhook` is true.
   */
  webhookUrl?: string;
  /**
   * Shared secret Telegram echoes in `X-Telegram-Bot-Api-Secret-Token`.
   * Required when `useWebhook` is true. Validated by grammy inside
   * `webhookCallback` — no verification code lives here.
   *
   * The adapter already throws when `useWebhook` is set without `webhookUrl`
   * or `webhookSecretToken`, so this layer only passes the values through and
   * deliberately does not duplicate that validation (§2a).
   *
   * A credential: treated exactly like `token` by the secret externalizer, so
   * it can be supplied as `${secrets:<ref>}` and never reaches disk in
   * cleartext.
   */
  webhookSecretToken?: string;
  /**
   * Discard updates Telegram queued while the process was down. Default
   * `false` (UBP-002, owner decision D3): a message sent during a crash,
   * upgrade or supervisor restart is answered after the restart, entering
   * through the gateway's `acceptInbound` like any live message. The default
   * is applied by the adapter (`TelegramAdapter` constructor,
   * `config.dropPendingUpdates ?? false`), not here.
   *
   * Only affects POLL-mode bots: grammy's `bot.start()` calls
   * `deleteWebhook({ drop_pending_updates })` on every invocation, so with
   * `true` every restart drops the backlog. In webhook mode `bot.start()` is
   * never called and this flag does nothing. Set it `true` only to have a
   * restart deliberately skip everything queued while the bot was down.
   */
  dropPendingUpdates?: boolean;
  /** See {@link BotBudgetConfig}. `telegram.bots.<n>.budget.dailyUsd`. */
  budget?: BotBudgetConfig;
  /**
   * Reply-prefix template (plan personality-presence-and-initiative §3). The
   * only placeholders are `{name}` and `{emoji}`, filled from the personality
   * bound to the lane (its `display.emoji`; an unset emoji is dropped with one
   * adjacent space). Applied by the gateway (`applyReplyPrefix`,
   * extensions/gateway/src/reply-prefix.ts) before dedup and the delivery
   * ledger; adapters never add it. Quote a value that ends in a space:
   * `replyPrefix: "[{name}] "`. Absent = replies unchanged.
   */
  replyPrefix?: string;
  /**
   * Count a group message that names the bound personality — a whole word,
   * case-insensitive — as a mention of the bot (`mentionsPersonalityName`,
   * packages/core/src/channel-presence.ts). Opt-in; absent = `false`.
   */
  mentionByName?: boolean;
}

export interface SlackAppConfig {
  id?: string;
  botToken: string;
  /**
   * Socket-Mode app-level token. Optional: required only when `mode.socket`
   * is in effect (which is the default). HTTP-mode apps have no Socket-Mode
   * connection and therefore no app token. Enforcement lives in the adapter,
   * not here (§8).
   */
  appToken?: string;
  signingSecret: string;
  bind: BotBinding;
  piiRedaction?: boolean;
  /**
   * Inbound transport. Absent = today's behaviour: Socket Mode.
   *
   * An additive boolean pair (§3b), and a MUTUALLY EXCLUSIVE one: Socket Mode
   * and HTTP Events are two transports for the SAME inbound event stream —
   * Slack's own dashboard treats them as alternatives, and there is no reason
   * to receive every event twice. The adapter throws when both are `true`;
   * this layer only records what the operator wrote.
   */
  mode?: {
    /** Connect over Socket Mode. Default `true`. Requires `appToken`. */
    socket?: boolean;
    /** Receive Events API deliveries over inbound HTTP. Default `false`. */
    http?: boolean;
  };
  /**
   * Route segment this app's HTTP receiver is mounted at, under
   * `/slack/events/`. Absent = the app's botKey. HTTP mode only.
   */
  webhookPath?: string;
  /** Channel mode for channels with no per-channel override. Absent = the
   *  adapter's own default (`mention_only`). Four values, not Telegram's five:
   *  the Slack adapter's enum has no `regex_match`
   *  (`extensions/platform-slack/src/config.ts`). `observe` records the
   *  channel and never replies in it — not even to an explicit @mention. */
  defaultChannelMode?: 'mention_only' | 'thread_follow' | 'all' | 'observe';
  /** Slack emoji name (no colons) reacted onto inbound messages to
   *  acknowledge receipt. Absent = the adapter's default (`eyes`). */
  receiptReaction?: string;
  /** Slack user IDs allowed to run `/ethos` and see the App Home tab's private
   *  sections. Narrows `channel_filter.slack` (`ownerUserId` +
   *  `recipientAllowlist`); it cannot widen it, so an id listed here that is
   *  not allowlisted on the message surface stays denied. Empty/absent = the
   *  `channel_filter.slack` allowlist alone. Both empty = nobody. */
  allowedSlashUsers?: string[];
  /** Slack `bot_id`s whose messages reach the agent. Empty/absent drops every
   *  bot/workflow message, which is the behaviour before this key existed. */
  allowedBotIds?: string[];
  /** Reply length (characters) above which the adapter posts a lead message
   *  plus the full answer as `answer.md` instead of a chunk wall. Absent = the
   *  adapter's default (9000); `0` disables the fallback. */
  longReplyThresholdChars?: number;
  /** See {@link BotBudgetConfig}. `slack.apps.<n>.budget.dailyUsd`. */
  budget?: BotBudgetConfig;
  /**
   * Reply-prefix template (plan personality-presence-and-initiative §3). The
   * only placeholders are `{name}` and `{emoji}`, filled from the personality
   * bound to the lane (its `display.emoji`; an unset emoji is dropped with one
   * adjacent space). Applied by the gateway (`applyReplyPrefix`,
   * extensions/gateway/src/reply-prefix.ts) before dedup and the delivery
   * ledger; adapters never add it. Quote a value that ends in a space:
   * `replyPrefix: "[{name}] "`. Absent = replies unchanged.
   */
  replyPrefix?: string;
  /**
   * Count a group message that names the bound personality — a whole word,
   * case-insensitive — as a mention of the bot (`mentionsPersonalityName`,
   * packages/core/src/channel-presence.ts). Opt-in; absent = `false`.
   */
  mentionByName?: boolean;
}

/**
 * Per-team runtime knobs that the gateway honors when a bot binds to
 * `bind.type === 'team'`. Keyed by team manifest name.
 */
export interface TeamRuntimeConfig {
  /** Stop the team supervisor when the gateway shuts down. Default false:
   *  supervisors are long-lived and outlive the gateway. */
  autoStop?: boolean;
}

export interface WhatsAppConfig {
  id?: string;
  session_dir?: string;
  default_mode?: 'all' | 'mention_only' | 'observe';
  allowed_numbers?: string[];
  /** When set, the adapter links via phone-number pairing code instead of QR.
   *  Stored as entered; the adapter strips non-digits before requesting. */
  phone_number?: string;
  /** Optional personality/team binding. Unlike slack/telegram (which require
   *  a bind), WhatsApp bind is optional — bind-less entries fall back to the
   *  default personality in the gateway. */
  bind?: BotBinding;
  piiRedaction?: boolean;
  /** See {@link BotBudgetConfig}. `whatsapp.<n>.budget.dailyUsd`. */
  budget?: BotBudgetConfig;
}

/**
 * Operator spending limit for ONE channel bot (plan openclaw-2026.9.6-gaps D5),
 * written under the bot's own entry: `telegram.bots.<n>.budget.dailyUsd`,
 * `slack.apps.<n>.budget.dailyUsd`, `whatsapp.<n>.budget.dailyUsd`.
 *
 * A setting, not identity — two deployments of the same personality can
 * disagree about it — so it lives here, never on `PersonalityConfig`. Enforced
 * per turn by `Gateway.enqueueTurn` (extensions/gateway) against the bot's
 * spend since 00:00 UTC; absent = no daily cap. The legacy scalar bots
 * (`telegramToken`, `discordToken`, email) have no entry to hang it on and so
 * cannot be capped this way.
 */
export interface BotBudgetConfig {
  /** USD a bot may spend per UTC day before its turns are refused. > 0. */
  dailyUsd: number;
  /**
   * `<bot entry>.budget.backgroundBlocksReplies` (plan
   * background-usage-accounting D14). Background spend (memory capture,
   * consolidation, the channel digest, …) always counts toward the gate that
   * stops BACKGROUND calls (`Gateway.backgroundGate`). It counts toward the
   * gate that refuses REPLIES (`Gateway.dailyCapReached`) only when this is
   * true. Absent = false: background never blocks a reply, at the cost that a
   * bot can spend up to about twice `dailyUsd` in one UTC day — background
   * stops once the total reaches the cap, replies continue until reply spend
   * alone reaches it. Set true for a hard ceiling.
   */
  backgroundBlocksReplies?: boolean;
}

export function buildBotBinding(
  kv: Record<string, string>,
  label: string,
): { bind: BotBinding | null; errors: string[] } {
  const type = kv['bind.type'];
  const name = kv['bind.name'];
  const errors: string[] = [];
  if (type !== 'personality' && type !== 'team') {
    errors.push(
      `${label}: missing or invalid 'bind.type' ` +
        `(got ${type === undefined ? 'nothing' : `'${type}'`}; ` +
        `must be 'personality' or 'team').`,
    );
  }
  if (!name) {
    errors.push(`${label}: missing required field 'bind.name'.`);
  }
  if (errors.length > 0) return { bind: null, errors };
  const allow = kv['bind.allowSlashSwitch'];
  const binding: BotBinding = { type: type as 'personality' | 'team', name: name as string };
  if (allow === 'true') binding.allowSlashSwitch = true;
  return { bind: binding, errors };
}

/**
 * `<entry>.budget.dailyUsd` → {@link BotBudgetConfig}, shared by the three bot
 * rosters that carry one. Reading the key through the tracked entry is what
 * marks it read for the U4 unknown-key notice (`ConfigKeyUse.trackIndexed`).
 * A value that is not a positive finite number is an error, like an invalid
 * `defaultChannelMode`: a cap the operator wrote and the gateway silently
 * ignored would be worse than no cap.
 */
function buildBotBudget(
  entry: Record<string, string>,
  label: string,
): { budget?: BotBudgetConfig; error?: string } {
  const raw = entry['budget.dailyUsd'];
  // Read before the early return: `ConfigKeyUse.track` counts only keys looked up.
  const blocks = entry['budget.backgroundBlocksReplies'];
  if (blocks !== undefined && blocks !== 'true' && blocks !== 'false') {
    return {
      error: `${label}: invalid budget.backgroundBlocksReplies '${blocks}' (expected true or false).`,
    };
  }
  if (raw === undefined) {
    if (blocks === undefined) return {};
    return {
      error: `${label}: budget.backgroundBlocksReplies needs budget.dailyUsd (there is no cap for it to apply to).`,
    };
  }
  const dailyUsd = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(dailyUsd) || dailyUsd <= 0) {
    return {
      error: `${label}: invalid budget.dailyUsd '${raw}' (expected a positive number of USD).`,
    };
  }
  return {
    budget: {
      dailyUsd,
      ...(blocks !== undefined ? { backgroundBlocksReplies: blocks === 'true' } : {}),
    },
  };
}

/**
 * Each platform's `defaultChannelMode` values, mirroring that adapter's own
 * `ChannelModeSchema` exactly — Telegram's five
 * (`extensions/platform-telegram/src/config.ts`), Slack's four
 * (`extensions/platform-slack/src/config.ts`) and Discord's four
 * (`extensions/platform-discord/src/config.ts`); neither Slack nor Discord
 * has `regex_match`. Kept as separate tables rather than one shared list
 * precisely because they differ: a mode an adapter cannot honour must not
 * validate here.
 */
const TELEGRAM_CHANNEL_MODES = [
  'mention_only',
  'thread_follow',
  'all',
  'regex_match',
  'observe',
] as const;
const SLACK_CHANNEL_MODES = ['mention_only', 'thread_follow', 'all', 'observe'] as const;
const DISCORD_CHANNEL_MODES = ['mention_only', 'thread_follow', 'all', 'observe'] as const;

export function buildTelegramBots(kv: Record<number, Record<string, string>>): {
  bots: TelegramBotConfig[];
  errors: string[];
} {
  const bots: TelegramBotConfig[] = [];
  const errors: string[] = [];
  for (const idx of sortedIndexes(kv)) {
    const entry = kv[idx];
    if (!entry) continue;
    const label = `telegram.bots[${idx}]`;
    if (!entry.token) {
      errors.push(`${label}: missing required field 'token'.`);
      continue;
    }
    const result = buildBotBinding(entry, label);
    if (result.errors.length > 0) {
      errors.push(...result.errors);
      continue;
    }
    if (!result.bind) continue;
    const bot: TelegramBotConfig = {
      token: entry.token,
      bind: result.bind,
      ...(entry.id ? { id: entry.id } : {}),
    };
    // Presence, not truthiness: `dropPendingUpdates: false` must survive as
    // boolean `false` rather than collapsing into "absent" (which means "let
    // the adapter's `?? true` default apply").
    if (entry.useWebhook !== undefined) bot.useWebhook = entry.useWebhook === 'true';
    if (entry.webhookUrl) bot.webhookUrl = entry.webhookUrl;
    if (entry.webhookSecretToken) bot.webhookSecretToken = entry.webhookSecretToken;
    if (entry.dropPendingUpdates !== undefined) {
      bot.dropPendingUpdates = entry.dropPendingUpdates === 'true';
    }
    const mode = entry.defaultChannelMode;
    if (mode) {
      if (!isOneOf(TELEGRAM_CHANNEL_MODES, mode)) {
        errors.push(
          `${label}: invalid defaultChannelMode '${mode}' (expected ${quotedList(TELEGRAM_CHANNEL_MODES)}).`,
        );
        continue;
      }
      bot.defaultChannelMode = mode;
    }
    const budget = buildBotBudget(entry, label);
    if (budget.error) {
      errors.push(budget.error);
      continue;
    }
    if (budget.budget) bot.budget = budget.budget;
    if (entry.replyPrefix) bot.replyPrefix = entry.replyPrefix;
    if (entry.mentionByName !== undefined) bot.mentionByName = entry.mentionByName === 'true';
    bots.push(bot);
  }
  return { bots, errors };
}

export function buildSlackApps(kv: Record<number, Record<string, string>>): {
  apps: SlackAppConfig[];
  errors: string[];
} {
  const apps: SlackAppConfig[] = [];
  const errors: string[] = [];
  for (const idx of sortedIndexes(kv)) {
    const entry = kv[idx];
    if (!entry) continue;
    const label = `slack.apps[${idx}]`;
    // `appToken` is NOT required here: it is needed only in Socket Mode, and
    // that is enforced by the adapter, which knows the resolved mode (§8).
    const missing = (['botToken', 'signingSecret'] as const).filter((k) => !entry[k]);
    if (missing.length > 0) {
      errors.push(`${label}: missing required field(s) ${missing.join(', ')}.`);
      continue;
    }
    const result = buildBotBinding(entry, label);
    if (result.errors.length > 0) {
      errors.push(...result.errors);
      continue;
    }
    if (!result.bind) continue;
    const app: SlackAppConfig = {
      botToken: entry.botToken,
      signingSecret: entry.signingSecret,
      bind: result.bind,
      ...(entry.id ? { id: entry.id } : {}),
      ...(entry.appToken ? { appToken: entry.appToken } : {}),
    };
    const mode = entry.defaultChannelMode;
    if (mode) {
      if (!isOneOf(SLACK_CHANNEL_MODES, mode)) {
        errors.push(
          `${label}: invalid defaultChannelMode '${mode}' (expected ${quotedList(SLACK_CHANNEL_MODES)}).`,
        );
        continue;
      }
      app.defaultChannelMode = mode;
    }
    if (entry.receiptReaction) app.receiptReaction = entry.receiptReaction;
    if (entry.allowedSlashUsers) {
      const users = entry.allowedSlashUsers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (users.length > 0) app.allowedSlashUsers = users;
    }
    if (entry.allowedBotIds) {
      const botIds = entry.allowedBotIds
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (botIds.length > 0) app.allowedBotIds = botIds;
    }
    if (entry.longReplyThresholdChars) {
      const threshold = Number(entry.longReplyThresholdChars);
      if (!Number.isInteger(threshold) || threshold < 0) {
        errors.push(
          `${label}: invalid longReplyThresholdChars '${entry.longReplyThresholdChars}' (expected a non-negative integer; 0 disables).`,
        );
        continue;
      }
      app.longReplyThresholdChars = threshold;
    }
    // `mode.socket` / `mode.http` arrive as flat `mode.<field>` keys, the same
    // way `bind.<field>` does. Absent = undefined, so the adapter's defaults
    // (socket on, http off) apply and today's behaviour is unchanged.
    const transport: NonNullable<SlackAppConfig['mode']> = {};
    if (entry['mode.socket'] !== undefined) transport.socket = entry['mode.socket'] === 'true';
    if (entry['mode.http'] !== undefined) transport.http = entry['mode.http'] === 'true';
    if (Object.keys(transport).length > 0) app.mode = transport;
    if (entry.webhookPath) app.webhookPath = entry.webhookPath;
    const budget = buildBotBudget(entry, label);
    if (budget.error) {
      errors.push(budget.error);
      continue;
    }
    if (budget.budget) app.budget = budget.budget;
    if (entry.replyPrefix) app.replyPrefix = entry.replyPrefix;
    if (entry.mentionByName !== undefined) app.mentionByName = entry.mentionByName === 'true';
    apps.push(app);
  }
  return { apps, errors };
}

export function buildWhatsApps(kv: Record<number, Record<string, string>>): {
  apps: WhatsAppConfig[];
  errors: string[];
} {
  const apps: WhatsAppConfig[] = [];
  const errors: string[] = [];
  for (const idx of sortedIndexes(kv)) {
    const entry = kv[idx];
    if (!entry) continue;
    const label = `whatsapp[${idx}]`;
    const app: WhatsAppConfig = {};
    if (entry.id) app.id = entry.id;
    if (entry.session_dir) app.session_dir = entry.session_dir;
    if (entry.phone_number) app.phone_number = entry.phone_number;
    if (entry.default_mode) {
      if (
        entry.default_mode === 'all' ||
        entry.default_mode === 'mention_only' ||
        entry.default_mode === 'observe'
      ) {
        app.default_mode = entry.default_mode;
      } else {
        errors.push(
          `${label}: invalid default_mode '${entry.default_mode}' (expected 'all', 'mention_only' or 'observe').`,
        );
        continue;
      }
    }
    if (entry.allowed_numbers) {
      const numbers = entry.allowed_numbers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (numbers.length > 0) app.allowed_numbers = numbers;
    }
    // WhatsApp bind is optional. Only build (and validate) a binding when the
    // operator supplied both bind.type and bind.name; otherwise leave it
    // undefined so the gateway falls back to the default personality.
    if (entry['bind.type'] && entry['bind.name']) {
      const result = buildBotBinding(entry, label);
      if (result.errors.length > 0) {
        errors.push(...result.errors);
        continue;
      }
      if (result.bind) app.bind = result.bind;
    }
    const budget = buildBotBudget(entry, label);
    if (budget.error) {
      errors.push(budget.error);
      continue;
    }
    if (budget.budget) app.budget = budget.budget;
    apps.push(app);
  }
  return { apps, errors };
}

export function buildTeamsConfig(
  kv: Record<string, Record<string, string>>,
): Record<string, TeamRuntimeConfig> | undefined {
  const names = Object.keys(kv);
  if (names.length === 0) return undefined;
  const out: Record<string, TeamRuntimeConfig> = {};
  for (const name of names) {
    const entry = kv[name];
    if (!entry) continue;
    const cfg: TeamRuntimeConfig = {};
    if (entry.autoStop === 'true') cfg.autoStop = true;
    out[name] = cfg;
  }
  return out;
}

/**
 * Discord's `discord.defaultChannelMode`. Loud rather than lenient, exactly
 * like the per-bot Telegram and Slack keys: silently dropping a typo would
 * leave an operator who asked for `observe` running a bot that answers, which
 * is the failure this key exists to prevent.
 */
export function buildDiscordDefaultMode(kv: Record<string, string>): {
  mode: (typeof DISCORD_CHANNEL_MODES)[number] | undefined;
  errors: string[];
} {
  const raw = kv.defaultChannelMode;
  if (!raw) return { mode: undefined, errors: [] };
  if (!isOneOf(DISCORD_CHANNEL_MODES, raw)) {
    return {
      mode: undefined,
      errors: [
        `discord: invalid defaultChannelMode '${raw}' (expected ${quotedList(DISCORD_CHANNEL_MODES)}).`,
      ],
    };
  }
  return { mode: raw, errors: [] };
}
