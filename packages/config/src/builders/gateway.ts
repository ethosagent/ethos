import type { ChannelFilterConfig, ChannelPlatformConfig } from '@ethosagent/safety-channel';
import type { EthosConfig } from '../config-types';
import { parseBoundedInt } from './utils';

/**
 * Gateway-wide knobs from the flat `gateway.<field>` keys.
 * `maxInboundMediaBytes` is bounded to 1 KiB–128 MiB: smaller than a kilobyte
 * rejects every real attachment, and every adapter buffers the whole download
 * in memory (`arrayBuffer()`), so the ceiling is what a Node heap can hold from
 * an untrusted sender — 128 MiB is over 5x the largest per-adapter default
 * (25 MB) and above every platform's own attachment limit. Out-of-range values
 * are dropped, leaving each adapter on its own platform default.
 */
export function buildGateway(
  kv: Record<string, string>,
  privateChatsKv: Record<string, string>,
  warnings: string[],
): EthosConfig['gateway'] | undefined {
  const result: NonNullable<EthosConfig['gateway']> = {};
  const raw = kv.maxInboundMediaBytes;
  if (raw !== undefined) {
    const n = parseBoundedInt(raw, 1024, 134_217_728);
    if (n !== undefined) result.maxInboundMediaBytes = n;
  }
  // Inbound spool knobs. Out-of-range values are dropped, leaving the gateway
  // on its default: a cap of 0 attempts would dead-letter every message before
  // it ran, and a replay age under a minute would dead-letter a normal restart.
  const spool: NonNullable<NonNullable<EthosConfig['gateway']>['inboundSpool']> = {};
  const attempts = kv['inboundSpool.maxAttempts'];
  if (attempts !== undefined) {
    const n = parseBoundedInt(attempts, 1, 100);
    if (n !== undefined) spool.maxAttempts = n;
  }
  const age = kv['inboundSpool.maxReplayAgeMs'];
  if (age !== undefined) {
    const n = parseBoundedInt(age, 60_000, 30 * 86_400_000);
    if (n !== undefined) spool.maxReplayAgeMs = n;
  }
  if (Object.keys(spool).length > 0) result.inboundSpool = spool;
  const privateChats = buildPrivateChats(privateChatsKv, warnings);
  if (privateChats) result.privateChats = privateChats;
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Trusted rooms from `gateway.private_chats.<platform>: <chatId,...>` (plan
 * personality-memory-boundary D9). A comma list, trimmed, empties and
 * duplicates removed. Any platform name is kept, like `channel_toolsets.*`, so
 * a plugin platform can list rooms too; a misspelt platform matches no chat
 * and leaves the room shared (fail-closed). Bad values warn and are dropped —
 * never an error, so a typo cannot stop boot: an id with whitespace inside it
 * (no platform's chat ids have any), and an entry that lists no ids at all.
 * Pinned by `__tests__/config-gateway-private-chats.test.ts`.
 */
function buildPrivateChats(
  kv: Record<string, string>,
  warnings: string[],
): Record<string, string[]> | undefined {
  const result: Record<string, string[]> = {};
  for (const [platform, raw] of Object.entries(kv)) {
    const ids: string[] = [];
    for (const id of raw.split(',').map((s) => s.trim())) {
      if (id === '' || ids.includes(id)) continue;
      if (/\s/.test(id)) {
        warnings.push(
          `gateway.private_chats.${platform}: '${id}' is not a chat id (contains whitespace) — ignored. Separate ids with commas.`,
        );
        continue;
      }
      ids.push(id);
    }
    if (ids.length > 0) result[platform] = ids;
    else {
      warnings.push(
        `gateway.private_chats.${platform}: lists no chat ids — ignored. Expected <chatId,...>.`,
      );
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Member auto-restart brake from the flat
 * `teamSupervisor.restartLoopGuard.<field>` keys. Both are positive integers —
 * `0` restarts would mean `auto_restart: true` never restarts anything, which
 * is what `auto_restart: false` already says. Returns `undefined` when nothing
 * survives, leaving the supervisor on its 5-restarts-in-60s defaults.
 */
export function buildRestartLoopGuard(
  kv: Record<string, string>,
): NonNullable<EthosConfig['teamSupervisor']>['restartLoopGuard'] | undefined {
  const result: NonNullable<NonNullable<EthosConfig['teamSupervisor']>['restartLoopGuard']> = {};
  const maxRestarts = kv.maxRestarts;
  if (maxRestarts !== undefined) {
    const n = parseBoundedInt(maxRestarts, 1, 1000);
    if (n !== undefined) result.maxRestarts = n;
  }
  const windowSeconds = kv.windowSeconds;
  if (windowSeconds !== undefined) {
    const n = parseBoundedInt(windowSeconds, 1, 86_400);
    if (n !== undefined) result.windowSeconds = n;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Discord channel-history backfill from the flat
 * `discord.missedMessageBackfill.<field>` keys. `limit` stops at 100 because
 * that is Discord's own `messages.fetch` ceiling — asking for more is an error
 * at the API, not a bigger read. Returns `undefined` when nothing survives, so
 * the adapter keeps today's unbounded-window, 50-message behaviour.
 */
export function buildDiscordBackfill(
  kv: Record<string, string>,
): NonNullable<EthosConfig['discord']>['missedMessageBackfill'] | undefined {
  const result: NonNullable<NonNullable<EthosConfig['discord']>['missedMessageBackfill']> = {};
  if (kv.enabled === 'true') result.enabled = true;
  else if (kv.enabled === 'false') result.enabled = false;
  const windowSeconds = kv.windowSeconds;
  if (windowSeconds !== undefined) {
    const n = parseBoundedInt(windowSeconds, 1, 604_800);
    if (n !== undefined) result.windowSeconds = n;
  }
  const limit = kv.limit;
  if (limit !== undefined) {
    const n = parseBoundedInt(limit, 1, 100);
    if (n !== undefined) result.limit = n;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Board WIP caps from the flat `kanban.<field>` keys. Both are positive
 * integers — `0` would mean "no task may ever run", which is a typo, not a
 * setting, so it is dropped along with negatives and non-numerics. Returns
 * `undefined` when nothing survives, leaving the board uncapped.
 */
export function buildKanban(kv: Record<string, string>): EthosConfig['kanban'] | undefined {
  const result: NonNullable<EthosConfig['kanban']> = {};
  for (const key of ['maxInProgress', 'maxInProgressPerProfile'] as const) {
    const raw = kv[key];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) result[key] = Math.floor(n);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

const GROUNDING_ON_FINDING = ['annotate', 'correct'] as const;

/**
 * `grounding.*` — ground-truth verification policy, from the flat keys and the
 * nested `grounding.kanban.*` ones.
 *
 * Loud rather than lenient on `onFinding`, following `voice.trunk.provider`:
 * the two values do materially different things (one annotates, the other
 * rewrites the next turn's prompt), so a typo silently falling back to
 * `annotate` would leave an operator who asked for `correct` believing they
 * had it. Every other field here is a boolean or a list, where "not the two
 * spellings of true/false" is unambiguous and simply drops.
 */
export function buildGrounding(
  kv: Record<string, string>,
  kanbanKv: Record<string, string>,
): { grounding?: EthosConfig['grounding']; errors: string[] } {
  if (Object.keys(kv).length === 0 && Object.keys(kanbanKv).length === 0) return { errors: [] };
  const errors: string[] = [];
  const result: NonNullable<EthosConfig['grounding']> = {};

  for (const key of ['enabled', 'showUnsupported', 'memoryTag'] as const) {
    const raw = kv[key];
    if (raw === 'true') result[key] = true;
    else if (raw === 'false') result[key] = false;
  }

  const onFinding = kv.onFinding;
  if (onFinding === 'annotate' || onFinding === 'correct') {
    result.onFinding = onFinding;
  } else if (onFinding !== undefined) {
    errors.push(
      `grounding.onFinding: invalid value '${onFinding}' (expected one of: ${GROUNDING_ON_FINDING.join(', ')}).`,
    );
  }

  const kanban: NonNullable<NonNullable<EthosConfig['grounding']>['kanban']> = {};
  if (kanbanKv.checks === 'true') kanban.checks = true;
  else if (kanbanKv.checks === 'false') kanban.checks = false;
  const allowed = kanbanKv.allowedCheckCommands;
  if (allowed !== undefined) {
    // Split on commas ONLY. A check command is several words (`pnpm test`), so
    // the whitespace split the other list-valued keys use would shred it into
    // tokens that match nothing.
    const commands = allowed
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (commands.length > 0) kanban.allowedCheckCommands = commands;
  }
  if (Object.keys(kanban).length > 0) result.kanban = kanban;

  if (errors.length > 0) return { errors };
  return {
    ...(Object.keys(result).length > 0 ? { grounding: result } : {}),
    errors: [],
  };
}

/** The `idleWatcher.<field>: <value>` config line; group 1 is the field. */
export const IDLE_WATCHER_LINE =
  /^idleWatcher\.(enabled|idleThresholdMs|startupCooldownMs|checkIntervalMs|wakePathConfirmed):\s*(.+)$/;

/**
 * Assemble the scale-to-zero idle-watcher config from parsed flat keys.
 * Returns `undefined` when nothing survives, so the watcher stays off.
 *
 * Both booleans are parsed STRICTLY — only a literal `true` is true. A typo
 * must never arm the watcher, and `wakePathConfirmed` is an operator
 * attestation, not a guess.
 *
 * The three `*Ms` keys require a POSITIVE integer. A blank value
 * (`idleThresholdMs: ""`, or a key whose value is only whitespace) is a typo,
 * and `Number('')` is `0` — which here would mean a zero-length idle threshold
 * or a zero cooldown, i.e. exit on the first sample. Treat blank as absent so
 * the manager default applies. (Unlike `approvalTimeoutMs`, `0` is meaningless
 * for all three, so it is rejected rather than honoured.)
 */
export function buildIdleWatcher(
  kv: Record<string, string>,
): EthosConfig['idleWatcher'] | undefined {
  const result: NonNullable<EthosConfig['idleWatcher']> = {};
  if (kv.enabled !== undefined) result.enabled = kv.enabled === 'true';
  if (kv.wakePathConfirmed !== undefined)
    result.wakePathConfirmed = kv.wakePathConfirmed === 'true';
  for (const key of ['idleThresholdMs', 'startupCooldownMs', 'checkIntervalMs'] as const) {
    const raw = kv[key];
    if (raw === undefined || raw.trim() === '') continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) result[key] = n;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Parse `pauseClockCorrection.<field>` (plan/phases/clock-tolerance-pass.md §7).
 * Returns undefined when the section is absent so `enabled` stays false by
 * omission — an absent section must mean today's behaviour, byte for byte.
 * A blank or non-positive `thresholdMs` is treated as absent so the detector's
 * own default applies, the same hazard `buildIdleWatcher` guards against.
 */
export function buildPauseClockCorrection(
  kv: Record<string, string>,
): EthosConfig['pauseClockCorrection'] | undefined {
  const result: NonNullable<EthosConfig['pauseClockCorrection']> = {};
  if (kv.enabled !== undefined) result.enabled = kv.enabled === 'true';
  const raw = kv.thresholdMs;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) result.thresholdMs = n;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Parse `pauseLifecycle.http.<field>`. Returns undefined when the section is
 * absent so an absent section behaves identically to before the feature
 * existed — same contract as `buildPauseClockCorrection` above.
 */
export function buildPauseLifecycleHttp(
  kv: Record<string, string>,
): NonNullable<EthosConfig['pauseLifecycle']>['http'] | undefined {
  const result: NonNullable<NonNullable<EthosConfig['pauseLifecycle']>['http']> = {};
  if (kv.url) result.url = kv.url;
  if (kv.token) result.token = kv.token;
  const raw = kv.timeoutMs;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) result.timeoutMs = n;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

const MAX_DECLINE_MESSAGE_CHARS = 500;

export function buildChannelFilter(
  kv: Record<string, Record<string, string>>,
  warnings: string[],
): ChannelFilterConfig | undefined {
  const platforms = Object.keys(kv);
  if (platforms.length === 0) return undefined;
  const out: ChannelFilterConfig = {};
  for (const platform of platforms) {
    const entry = kv[platform];
    if (!entry) continue;
    const cfg: ChannelPlatformConfig = {};
    if (entry.enable === 'false') cfg.enabled = false;
    else if (entry.enable === 'true') cfg.enabled = true;
    if (entry.ownerUserId) cfg.ownerUserId = entry.ownerUserId;
    if (entry.recipientAllowlist) {
      cfg.recipientAllowlist = entry.recipientAllowlist
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (
      entry.dmPolicy === 'pairing' ||
      entry.dmPolicy === 'allowlist' ||
      entry.dmPolicy === 'queue' ||
      entry.dmPolicy === 'reject' ||
      entry.dmPolicy === 'silent-drop' ||
      entry.dmPolicy === 'decline'
    ) {
      cfg.dmPolicy = entry.dmPolicy;
    }
    if (entry.declineMessage) {
      if (entry.declineMessage.length > MAX_DECLINE_MESSAGE_CHARS) {
        warnings.push(
          `channel_filter.${platform}.declineMessage is longer than ${MAX_DECLINE_MESSAGE_CHARS} characters; using the default`,
        );
      } else {
        cfg.declineMessage = entry.declineMessage;
      }
    }
    if (
      entry.contextVisibility === 'all' ||
      entry.contextVisibility === 'allowlist' ||
      entry.contextVisibility === 'allowlist_quote'
    ) {
      cfg.contextVisibility = entry.contextVisibility;
    }
    out[platform] = cfg;
  }
  return out;
}
