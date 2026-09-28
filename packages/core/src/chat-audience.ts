// Audience of a CHAT (a delivery target or a stored session), as opposed to a
// running turn (plan personality-memory-boundary-and-self-amendment, G1). The
// running turn's audience is `resolveTurnAudience`
// (./agent-loop/audience.ts); this file answers the two questions asked
// outside a turn:
//
//   - `targetAudience` — would a message delivered to `platform:chatId` be
//     read by one person? Used by schedules and jobs that carry a delivery
//     target but no stamp.
//   - `isSharedSession` — does this session run shared? Its stamp when it has
//     one, else its key shape (pre-upgrade group sessions were never stamped).
//     Also the audience turn-setup gives a turn whose caller named none.
//   - `turnWasShared` — did a turn in this session ever run with personality
//     memory withheld? `isSharedSession` OR the D8 marker. THE question every
//     post-turn process that could carry a conversation into private memory
//     asks (memory capture, the improvement fork, nightly/evolve selection,
//     learning cases) — one helper, so they cannot disagree (verification
//     round B2).
//
// Pinned by `packages/core/src/__tests__/chat-audience.test.ts`.

import type { Session, TurnAudience } from '@ethosagent/types';
import { ROOM_AUDIENCE_METADATA_KEY } from './agent-loop/audience';

/**
 * The `Session.metadata` key marking a session in which a turn ran with
 * personality memory withheld from a non-owner DM sender (D8,
 * `withPersonalityMemoryWithheld`). Only ever `true`. It does NOT narrow later
 * turns — `resolveTurnAudience` never reads it, so the sender keeps their own
 * `user:<id>` read — it only tells post-turn learners (`turnWasShared`) that
 * the conversation is a stranger's, not the owner's.
 */
export const PERSONALITY_MEMORY_WITHHELD_METADATA_KEY = 'personalityMemoryWithheld';

/** The operator's trusted rooms (`gateway.private_chats.<platform>`), by platform + chat id. */
export interface PrivateChatSet {
  has(platform: string, chatId: string): boolean;
}

/**
 * A {@link PrivateChatSet} over the parsed `gateway.private_chats` map
 * (`EthosConfig.gateway.privateChats`, packages/config): exact platform +
 * chat id membership, no normalisation. Keyed on platform + chat id only, so
 * every bot on that platform treats a listed room as trusted. A snapshot —
 * later changes to `lists` are not seen.
 */
export function privateChatSetFrom(
  lists: Readonly<Record<string, readonly string[]>> | undefined,
): PrivateChatSet {
  const byPlatform = new Map<string, ReadonlySet<string>>();
  for (const [platform, ids] of Object.entries(lists ?? {})) {
    byPlatform.set(platform, new Set(ids));
  }
  return { has: (platform, chatId) => byPlatform.get(platform)?.has(chatId) === true };
}

/**
 * Platforms whose gateway session keys are channel lane keys
 * (`buildLaneKey(platform, botKey, chatId[, threadId])`, ./lane-key.ts). A key
 * on any other platform (`cli:`, `web:`, `acp:`, …) is not classified by its
 * shape; only its stamp can make it shared.
 */
const CHANNEL_PLATFORMS: ReadonlySet<string> = new Set([
  'telegram',
  'slack',
  'discord',
  'whatsapp',
  'email',
]);

/**
 * `'private'` when the chat is a listed trusted room, or when its id shape
 * proves a one-to-one chat: a positive Telegram id, a WhatsApp user JID
 * (`@s.whatsapp.net` / `@lid`), a Slack `D…` id, or any `web` target.
 * `'shared'` otherwise — Discord and email ids cannot be classified, so they
 * fail closed.
 */
export function targetAudience(
  platform: string,
  chatId: string,
  privateChats?: PrivateChatSet,
): TurnAudience {
  if (privateChats?.has(platform, chatId)) return 'private';
  switch (platform) {
    case 'web':
      return 'private';
    case 'telegram':
      return /^\d+$/.test(chatId) ? 'private' : 'shared';
    case 'whatsapp':
      return chatId.endsWith('@s.whatsapp.net') || chatId.endsWith('@lid') ? 'private' : 'shared';
    case 'slack':
      return chatId.startsWith('D') ? 'private' : 'shared';
    default:
      return 'shared';
  }
}

/**
 * True when the session carries the sticky `'shared'` stamp; false when it
 * carries the judged `'private'` stamp; otherwise (no stamp — a session
 * created before the stamp existed, or never run by a caller that judged it)
 * true when its key parses as a channel lane whose chat is not provably
 * private (`targetAudience`). A key that does not parse as a channel lane is
 * judged by its stamp alone.
 */
export function isSharedSession(
  session: Pick<Session, 'key' | 'metadata'>,
  privateChats?: PrivateChatSet,
): boolean {
  const stamp = session.metadata?.[ROOM_AUDIENCE_METADATA_KEY];
  if (stamp === 'shared') return true;
  if (stamp === 'private') return false;
  return keyShapeShared(session.key, privateChats);
}

/**
 * True when a post-turn process must treat this session's conversation as NOT
 * the owner's: it is shared (`isSharedSession`), or a turn in it ran with
 * personality memory withheld (the D8 marker,
 * {@link PERSONALITY_MEMORY_WITHHELD_METADATA_KEY}). The one filter memory
 * capture, the improvement fork, nightly/evolve session selection, learning
 * cases and web/CLI evolve use. Pinned by
 * `packages/core/src/__tests__/chat-audience.test.ts`.
 */
export function turnWasShared(
  session: Pick<Session, 'key' | 'metadata'>,
  privateChats?: PrivateChatSet,
): boolean {
  if (session.metadata?.[PERSONALITY_MEMORY_WITHHELD_METADATA_KEY] === true) return true;
  return isSharedSession(session, privateChats);
}

/**
 * The metadata turn-setup writes for this turn, or `undefined` when nothing
 * changes. MERGES into the existing metadata (`SessionStore.updateSession`
 * replaces it wholesale). Three writes, each only when missing:
 *
 *   - a shared turn stamps `'shared'` (sticky, overrides a `'private'`
 *     judgement — shared only narrows);
 *   - a private turn on an UNSTAMPED session whose key shape reads shared
 *     stamps the judged `'private'` (a Discord/email DM, a listed room), so
 *     post-turn learners stop excluding it on its key (verification round B3)
 *     — only when `judged` is true, i.e. the caller set
 *     `RunOptions.judgeAudience` (the gateway alone, verification round E5);
 *   - a D8 turn (`personalityMemoryWithheld`) sets the withheld marker.
 *
 * Called by turn-setup (packages/core/src/agent-loop/stages/turn-setup.ts);
 * pinned by `packages/core/src/__tests__/shared-audience.test.ts` and
 * `chat-audience.test.ts`.
 */
export function sessionAudienceStampFor(
  audience: TurnAudience,
  personalityMemoryWithheld: boolean,
  session: Pick<Session, 'key' | 'metadata'>,
  judged = false,
): Record<string, unknown> | undefined {
  const current = session.metadata ?? {};
  const next: Record<string, unknown> = { ...current };
  let changed = false;
  const stamp = current[ROOM_AUDIENCE_METADATA_KEY];
  if (audience === 'shared' && stamp !== 'shared') {
    next[ROOM_AUDIENCE_METADATA_KEY] = 'shared';
    changed = true;
  } else if (
    judged &&
    audience === 'private' &&
    stamp === undefined &&
    keyShapeShared(session.key)
  ) {
    next[ROOM_AUDIENCE_METADATA_KEY] = 'private';
    changed = true;
  }
  if (personalityMemoryWithheld && current[PERSONALITY_MEMORY_WITHHELD_METADATA_KEY] !== true) {
    next[PERSONALITY_MEMORY_WITHHELD_METADATA_KEY] = true;
    changed = true;
  }
  return changed ? next : undefined;
}

/** The key-shape half of `isSharedSession`: a channel lane key whose chat is not provably private. */
function keyShapeShared(key: string, privateChats?: PrivateChatSet): boolean {
  const segments = key.split(':');
  const [platformSeg, botKeySeg, chatSeg] = segments;
  if (platformSeg === undefined || botKeySeg === undefined || chatSeg === undefined) return false;
  const platform = safeDecode(platformSeg);
  if (platform === undefined || !CHANNEL_PLATFORMS.has(platform)) return false;
  const chatId = safeDecode(chatSeg);
  // A channel-platform key that did not come from `buildLaneKey` cannot be
  // proven private: fail closed.
  if (chatId === undefined) return true;
  return targetAudience(platform, chatId, privateChats) !== 'private';
}

function safeDecode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}
