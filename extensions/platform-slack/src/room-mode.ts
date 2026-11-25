// Stamping of the effective channel mode and room metadata onto inbound
// messages (plan channel-prompts L7, L12), moved out of `adapter.ts`.

import type { InboundMessage } from '@ethosagent/types';
import type { RoomModeDefault } from './config';
import type { EnvelopeMeta } from './events/messages';
import type { SlackRoomMetadata } from './room-metadata';

/** Stamp the diagnostic effective mode and its source (plan channel-prompts L12). */
export function stampChannelMode(msg: InboundMessage, meta?: EnvelopeMeta): InboundMessage {
  if (!meta?.effectiveMode) return msg;
  return {
    ...msg,
    channelMode: meta.effectiveMode,
    ...(meta.modeSource ? { channelModeSource: meta.modeSource } : {}),
  };
}

/** Stamp untrusted room metadata + the effective mode; never throws. */
export async function stampRoomMetadata(
  msg: InboundMessage,
  meta: EnvelopeMeta | undefined,
  fetchMetadata: ((channelId: string) => Promise<SlackRoomMetadata | undefined>) | undefined,
): Promise<InboundMessage> {
  const metadata = fetchMetadata ? await fetchMetadata(msg.chatId) : undefined;
  return { ...stampChannelMode(msg, meta), ...(metadata ? { roomMetadata: metadata } : {}) };
}

/**
 * Route one envelope through stamping, then `deliver`. With `fetchMetadata` on,
 * room messages go through one chain per channel: a cold `conversations.info`
 * must not let a later message overtake an earlier one (the wait is bounded by
 * `createSlackRoomMetadata`'s `waitMs`). Pinned by
 * `__tests__/room-metadata.test.ts` ('delivery order').
 */
export function deliverStamped(
  msg: InboundMessage,
  meta: EnvelopeMeta | undefined,
  deps: {
    /** Present when `fetch_metadata` is on. */
    stamp?: (msg: InboundMessage, meta?: EnvelopeMeta) => Promise<InboundMessage>;
    chain: (key: string, step: () => Promise<void>) => void;
  },
  deliver: (m: InboundMessage) => void,
): void {
  if (deps.stamp && !msg.isDm) {
    const stamp = deps.stamp;
    deps.chain(msg.chatId, async () => {
      deliver(await stamp(msg, meta).catch(() => stampChannelMode(msg, meta)));
    });
  } else if (meta?.effectiveMode && !msg.isDm) {
    deliver(stampChannelMode(msg, meta));
  } else {
    deliver(msg);
  }
}

/** The room-mode fields every triage/slash context carries. */
export function roomModeFields(a: {
  defaultChannelModeConfigured: boolean;
  roomModeDefault?: RoomModeDefault | undefined;
}): { defaultChannelModeConfigured: boolean; roomModeDefault?: RoomModeDefault } {
  return {
    defaultChannelModeConfigured: a.defaultChannelModeConfigured,
    ...(a.roomModeDefault ? { roomModeDefault: a.roomModeDefault } : {}),
  };
}
