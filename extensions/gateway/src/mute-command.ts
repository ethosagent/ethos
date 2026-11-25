// `/mute` gateway command, moved out of index.ts (size limit). Pure code move.

import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { parseMuteDuration } from './quiet-hours';

/** What `handleMuteCommand` needs from `Gateway`, resolved for one message. */
export interface MuteDeps {
  readonly laneMutes: Map<string, number>;
  /** `channel_filter.<platform>.ownerUserId` for the message's platform. */
  readonly ownerUserId: string | undefined;
  /** Whether the message's sender is the owner (`Gateway.isOwner`). */
  readonly isOwner: boolean;
  readonly persist: () => Promise<void>;
}

/**
 * `/mute <30m|2h|1d>` holds this lane's unprompted notices; `/mute off` ends it.
 *
 * Both change the lane for everyone in it, so they take `/personality`'s
 * group rule (plan openclaw-advisory-fixes D20/D21), as `/budget reset` does:
 * in a group only `channel_filter.<platform>.ownerUserId` may change the
 * mute, and a group on a platform with no owner refuses outright. DMs and the
 * read-only `/mute` stay open. Pinned by `__tests__/mute-owner.test.ts`.
 */
export async function handleMuteCommand(
  deps: MuteDeps,
  text: string,
  laneKey: string,
  message: InboundMessage,
  adapter: PlatformAdapter,
  threadId: string | undefined,
): Promise<void> {
  const arg = text.split(/\s+/).slice(1).join(' ');
  const parsed = parseMuteDuration(arg);
  let reply: string;
  if (parsed !== null && !message.isDm && !deps.isOwner) {
    reply =
      deps.ownerUserId === undefined
        ? `Muting notices in a group needs an owner. ` +
          `Set channel_filter.${message.platform}.ownerUserId in config.yaml.`
        : 'Only the bot owner can mute notices in a group.';
  } else if (parsed === null) {
    const until = deps.laneMutes.get(laneKey);
    reply =
      until !== undefined && until > Date.now()
        ? `Notices muted in this chat until ${new Date(until).toISOString()}.\nUsage: /mute <30m|2h|1d|off>`
        : 'Usage: /mute <30m|2h|1d|off> — hold background notices in this chat.';
  } else if (parsed === 'off') {
    deps.laneMutes.delete(laneKey);
    await deps.persist();
    reply = '✓ Unmuted. Held notices arrive within a minute.';
  } else {
    const until = Date.now() + parsed;
    deps.laneMutes.set(laneKey, until);
    await deps.persist();
    reply = `✓ Notices muted in this chat until ${new Date(until).toISOString()}. Replies to your messages still arrive.`;
  }
  await adapter.send(message.chatId, { text: reply, threadId }).catch(() => {});
}
