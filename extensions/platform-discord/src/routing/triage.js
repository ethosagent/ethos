// Translates a raw Discord event into an `InboundMessage` envelope and
// decides whether it reaches the agent. All Discord-specific decisions
// (channel-mode, thread isolation, mention extraction) live here.
import { DEFAULT_CHANNEL_MODE } from '../config';
import { shouldRespond } from './channel-mode';
export async function triageMessage(msg, ctx) {
  const chatId = msg.isThread ? (msg.parentChannelId ?? msg.channelId) : msg.channelId;
  const channelMode = resolveChannelMode(chatId, ctx);
  const text = msg.isMention ? stripMentions(msg.text).trim() : msg.text.trim();
  if (!text) return { drop: 'no_text', effectiveMode: channelMode };
  const threadId = msg.isThread ? msg.threadId : undefined;
  const hasBotPosted =
    threadId && ctx.threadState ? ctx.threadState.hasBotPosted(chatId, threadId) : false;
  const responds = shouldRespond({
    isDm: msg.isDm,
    isGroupMention: msg.isMention,
    channelMode,
    hasBotPosted,
  });
  if (!responds) return { drop: 'channel_mode', effectiveMode: channelMode };
  return {
    envelope: buildEnvelope({
      botKey: ctx.botKey,
      chatId,
      userId: msg.userId,
      username: msg.username,
      text,
      messageId: msg.messageId,
      threadId,
      isDm: msg.isDm,
      isGroupMention: msg.isMention,
      replyToId: msg.reference?.messageId,
      replyToUserId: msg.reference?.userId,
      raw: msg.raw,
    }),
    effectiveMode: channelMode,
  };
}
export function resolveChannelMode(channel, ctx) {
  const override = ctx.channelOverrides?.get(channel);
  return override ?? ctx.defaultChannelMode ?? DEFAULT_CHANNEL_MODE;
}
function buildEnvelope(input) {
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
    isGroupMention: input.isGroupMention,
    messageId: input.messageId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    raw: input.raw,
  };
}
/** Remove every `<@USERID>` mention so the agent sees the plain message text. */
export function stripMentions(text) {
  return text.replace(/<@[A-Za-z0-9!&]+>/g, '');
}
