// Translates a raw Discord event into an `InboundMessage` envelope and
// decides whether it reaches the agent. All Discord-specific decisions
// (channel-mode, thread isolation, mention extraction) live here.

import type { ChannelOverrideStore } from '@ethosagent/core';
import { evaluateChannelMode } from '@ethosagent/core';
import type { InboundMessage } from '@ethosagent/types';
import {
  CHANNEL_MODES,
  type ChannelMode,
  DEFAULT_CHANNEL_MODE,
  type RoomModeDefault,
} from '../config';
import type { ThreadStateStore } from '../store/thread-state';

/** What the adapter knows about itself + its persistent state. */
export interface TriageContext {
  botKey: string;
  defaultChannelMode: ChannelMode;
  /** `defaultChannelMode` came from the platform config (not the adapter's built-in). */
  defaultChannelModeConfigured?: boolean;
  channelOverrides?: ChannelOverrideStore<ChannelMode>;
  /**
   * Room config's default reply mode (plan channel-prompts L12), injected by the
   * host so this package never imports the gateway. Sits BELOW a runtime
   * override and ABOVE the platform default. Absent: today's behaviour.
   */
  roomModeDefault?: RoomModeDefault;
  threadState?: ThreadStateStore;
}

export interface RawDiscordMessage {
  channelId: string;
  userId: string;
  username?: string;
  text: string;
  messageId: string;
  isDm: boolean;
  /**
   * A DM-based channel that is not a one-to-one DM (a group DM). Still routed
   * as a DM (`isDm`); the envelope carries `audienceHint: 'shared'` so the
   * turn runs without private memory (plan personality-memory-boundary D10).
   */
  isGroupDm?: boolean;
  isThread: boolean;
  threadId?: string;
  parentChannelId?: string;
  isMention: boolean;
  /** `isMention` is true ONLY because the text names the bound personality
   *  (`mentionByName`), not an @mention of the bot. Feeds `TriageResult.nameOnly`. */
  mentionIsNameOnly?: boolean;
  reference?: { messageId?: string; userId?: string };
  /** Platform send time (ms) — `Message.createdTimestamp`. Orders the transcript. */
  sentAt: number;
  raw: unknown;
}

/** What the room-config default needs beyond the chat id. */
export interface ModeScope {
  threadId?: string;
  isDm?: boolean;
}

export interface TriageResult {
  /** Built envelope; only present when the message reaches the agent. */
  envelope?: InboundMessage;
  /** Reason for dropping; surfaced in logs when present. */
  drop?: 'no_text' | 'channel_mode';
  /**
   * Effective channel mode after overrides — surfaced for diagnostics.
   *
   * `string`, not `ChannelMode`: a stored override this build's enum cannot
   * read is preserved verbatim by `ChannelOverrideStore` (rather than dropped
   * and replaced by the answering default), so this reports the string that
   * actually governed the decision. That is also where the operator learns
   * about a bad override — the same value reaches `/ethos help`.
   */
  effectiveMode: string;
  /** Which layer supplied `effectiveMode` (diagnostic; stamped as `channelModeSource`). */
  modeSource: NonNullable<InboundMessage['channelModeSource']>;
  /**
   * `true` when the message reaches the agent ONLY because it names the bound
   * personality: without the name it would not be answered. No receipt
   * reaction goes on it — the channel filter may still drop it (a
   * non-allowlisted member), and nothing would clear the reaction.
   */
  nameOnly?: true;
}

export async function triageMessage(
  msg: RawDiscordMessage,
  ctx: TriageContext,
): Promise<TriageResult> {
  const chatId = msg.isThread ? (msg.parentChannelId ?? msg.channelId) : msg.channelId;
  const { mode: channelMode, source: modeSource } = resolveChannelModeSource(chatId, ctx, {
    isDm: msg.isDm,
    ...(msg.isThread && msg.threadId ? { threadId: msg.threadId } : {}),
  });

  const text = msg.isMention ? stripMentions(msg.text).trim() : msg.text.trim();
  if (!text) return { drop: 'no_text', effectiveMode: channelMode, modeSource };

  const threadId = msg.isThread ? msg.threadId : undefined;
  const hasBotPosted =
    threadId && ctx.threadState ? ctx.threadState.hasBotPosted(chatId, threadId) : false;

  // The one shared decision (`@ethosagent/core`), not a Discord-local matrix.
  // Note what it can now answer that a boolean could not: `observe` says do
  // NOT reply but DO record.
  const decision = evaluateChannelMode({
    isDm: msg.isDm,
    isGroupMention: msg.isMention,
    channelMode,
    supportedModes: CHANNEL_MODES,
    hasBotPosted,
  });

  // Only a message that is neither answered nor recorded is dropped here.
  if (!decision.shouldRecord)
    return { drop: 'channel_mode', effectiveMode: channelMode, modeSource };

  const nameOnly =
    msg.mentionIsNameOnly === true &&
    decision.shouldReply &&
    !evaluateChannelMode({
      isDm: msg.isDm,
      isGroupMention: false,
      channelMode,
      supportedModes: CHANNEL_MODES,
      hasBotPosted,
    }).shouldReply;

  return {
    ...(nameOnly ? { nameOnly: true as const } : {}),
    envelope: buildEnvelope({
      botKey: ctx.botKey,
      chatId,
      userId: msg.userId,
      username: msg.username,
      text,
      messageId: msg.messageId,
      threadId,
      isDm: msg.isDm,
      shared: msg.isGroupDm === true,
      isGroupMention: msg.isMention,
      replyToId: msg.reference?.messageId,
      replyToUserId: msg.reference?.userId,
      // Recorded, not answered. The gateway reads this flag, writes the
      // transcript row and returns before the channel filter ever runs.
      recordOnly: !decision.shouldReply,
      sentAt: msg.sentAt,
      raw: msg.raw,
    }),
    effectiveMode: channelMode,
    modeSource,
  };
}

/**
 * The chat's effective mode.
 *
 * Returns `string`, not `ChannelMode`. Three cases, and the middle one is the
 * bug this shape exists to close:
 *
 *   - no override stored      → the configured default (unchanged).
 *   - an override this build's enum REJECTS → the stored string verbatim,
 *     which `evaluateChannelMode` does not recognise and therefore fails
 *     closed on. The store used to drop such a record, making it
 *     indistinguishable from "no override" and laundering it into the
 *     answering `mention_only` default.
 *   - a valid override        → its mode (unchanged).
 */
/**
 * May the bot put VISIBLE content into this channel?
 *
 * Slack's `canSpeakInChannel` (`extensions/platform-slack/src/routing/triage.ts`)
 * with the same contract and the same argument for `isGroupMention: true` — a
 * human has already addressed the bot directly, so the only open question is
 * whether the ROOM permits a reply at all. Copied rather than shared: the two
 * packages have no common module below them, and each must pass its OWN
 * `CHANNEL_MODES` to `evaluateChannelMode` (that is the whole point of
 * `supportedModes`), so a shared helper would need the enum passed in anyway.
 *
 * Discord's only non-message path that can put content in a room is the
 * `/ethos ask` slash command (`../commands/ask.ts`); the approval and clarify
 * interactions reply to the clicker, not the room. `isDm` is required, never
 * defaulted — a hard-coded `false` is exactly what made Slack's `/ethos ask`
 * refuse in a DM.
 */
export function canSpeakInChannel(channelMode: string, isDm: boolean): boolean {
  return evaluateChannelMode({
    isDm,
    isGroupMention: true,
    channelMode,
    supportedModes: CHANNEL_MODES,
  }).shouldReply;
}

export function resolveChannelMode(
  channel: string,
  ctx: TriageContext,
  scope: ModeScope = {},
): string {
  // `.mode` — the shared store indexes `{ mode, regexPattern? }`, where
  // Discord's own copy indexed a bare mode.
  return resolveChannelModeSource(channel, ctx, scope).mode;
}

/**
 * `resolveChannelMode` plus which layer supplied the mode. Precedence (plan
 * channel-prompts L12): runtime `ChannelOverrideStore` override (the store stays
 * the only writer) > room config `mode` > platform `defaultChannelMode` >
 * the adapter's built-in default. A room mode outside this build's enum is
 * returned as-is and fails closed in `evaluateChannelMode`.
 */
export function resolveChannelModeSource(
  channel: string,
  ctx: TriageContext,
  scope: ModeScope = {},
): { mode: string; source: NonNullable<InboundMessage['channelModeSource']> } {
  const override = ctx.channelOverrides?.get(channel);
  if (override) return { mode: override.mode, source: 'runtime' };
  const room = ctx.roomModeDefault?.({
    chatId: channel,
    ...(scope.threadId ? { threadId: scope.threadId } : {}),
    isDm: scope.isDm ?? false,
  });
  if (room !== undefined) return { mode: room, source: 'room' };
  if (ctx.defaultChannelModeConfigured) return { mode: ctx.defaultChannelMode, source: 'platform' };
  return { mode: ctx.defaultChannelMode ?? DEFAULT_CHANNEL_MODE, source: 'default' };
}

interface EnvelopeInputs {
  botKey: string;
  chatId: string;
  userId: string;
  username?: string;
  text: string;
  messageId: string;
  threadId: string | undefined;
  isDm: boolean;
  shared: boolean;
  isGroupMention: boolean;
  replyToId?: string;
  replyToUserId?: string;
  recordOnly: boolean;
  sentAt: number;
  raw: unknown;
}

function buildEnvelope(input: EnvelopeInputs): InboundMessage {
  return {
    platform: 'discord',
    botKey: input.botKey,
    chatId: input.chatId,
    userId: input.userId,
    username: input.username,
    text: input.text,
    replyToId: input.replyToId,
    replyToUserId: input.replyToUserId,
    isDm: input.isDm,
    ...(input.shared ? { audienceHint: 'shared' as const } : {}),
    isGroupMention: input.isGroupMention,
    messageId: input.messageId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    recordOnly: input.recordOnly,
    sentAt: input.sentAt,
    raw: input.raw,
  };
}

/** Remove every `<@USERID>` mention so the agent sees the plain message text. */
export function stripMentions(text: string): string {
  return text.replace(/<@[A-Za-z0-9!&]+>/g, '');
}
