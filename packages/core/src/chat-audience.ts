// Audience of a CHAT (a delivery target or a stored session), as opposed to a
// running turn (plan personality-memory-boundary-and-self-amendment, G1). The
// running turn's audience is `resolveTurnAudience`
// (./agent-loop/audience.ts); this file answers the two questions asked
// outside a turn:
//
//   - `targetAudience` — would a message delivered to `platform:chatId` be
//     read by one person? Used by schedules and jobs that carry a delivery
//     target but no stamp.
//   - `isSharedSession` — has this session ever been shared? Used by every
//     post-turn process that could carry room content into private memory,
//     including pre-upgrade group sessions that were never stamped.
//
// Pinned by `packages/core/src/__tests__/chat-audience.test.ts`.

import type { Session, TurnAudience } from '@ethosagent/types';
import { ROOM_AUDIENCE_METADATA_KEY } from './agent-loop/audience';

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
 * True when the session carries the sticky `'shared'` stamp, OR its key parses
 * as a channel lane whose chat is not provably private (`targetAudience`). The
 * second clause covers group sessions created before the stamp existed.
 * A key that does not parse as a channel lane is judged by its stamp alone.
 */
export function isSharedSession(
  session: Pick<Session, 'key' | 'metadata'>,
  privateChats?: PrivateChatSet,
): boolean {
  if (session.metadata?.[ROOM_AUDIENCE_METADATA_KEY] === 'shared') return true;
  const segments = session.key.split(':');
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
