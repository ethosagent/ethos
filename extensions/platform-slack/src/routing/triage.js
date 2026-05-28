// Translates a raw Slack event into an `InboundMessage` envelope and
// decides whether it reaches the agent. All Slack-specific decisions
// (channel-mode, thread isolation, mention extraction) live here.
import { DEFAULT_CHANNEL_MODE } from '../config';
import { shouldRespond } from './channel-mode';
export async function triageMessage(msg, ctx) {
  const channelMode = resolveChannelMode(msg.channel, ctx);
  if (msg.subtype && msg.subtype !== 'file_share')
    return { drop: 'subtype', effectiveMode: channelMode };
  const text = msg.text?.trim() ?? '';
  const hasFiles = msg.subtype === 'file_share' && Array.isArray(msg.files) && msg.files.length > 0;
  if (!text && !hasFiles) return { drop: 'no_text', effectiveMode: channelMode };
  const isDm = msg.channel_type === 'im';
  const threadTs = msg.thread_ts;
  const hasBotPosted =
    threadTs && ctx.threadState ? ctx.threadState.hasBotPosted(msg.channel, threadTs) : false;
  // app_mention has its own handler; the message handler is mention-blind.
  // shouldRespond gets isGroupMention=false here on purpose.
  const responds = shouldRespond({
    isDm,
    isGroupMention: false,
    channelMode,
    hasBotPosted,
  });
  if (!responds) return { drop: 'channel_mode', effectiveMode: channelMode };
  return {
    envelope: buildEnvelope({
      botKey: ctx.botKey,
      channel: msg.channel,
      userId: msg.user,
      text: text || (hasFiles ? '(file attachment)' : ''),
      ts: msg.ts,
      threadTs,
      isDm,
      isGroupMention: false,
      raw: msg,
    }),
    effectiveMode: channelMode,
  };
}
export async function triageMention(evt, ctx) {
  const channelMode = resolveChannelMode(evt.channel, ctx);
  // @mentions always reach the agent regardless of mode — the user is
  // explicitly addressing the bot.
  const text = stripMentions(evt.text).trim();
  if (!text) return { drop: 'no_text', effectiveMode: channelMode };
  return {
    envelope: buildEnvelope({
      botKey: ctx.botKey,
      channel: evt.channel,
      userId: evt.user,
      text,
      ts: evt.ts,
      threadTs: evt.thread_ts,
      isDm: false,
      isGroupMention: true,
      raw: evt,
    }),
    effectiveMode: channelMode,
  };
}
export function resolveChannelMode(channel, ctx) {
  const override = ctx.channelOverrides?.get(channel);
  return override ?? ctx.defaultChannelMode ?? DEFAULT_CHANNEL_MODE;
}
function buildEnvelope(input) {
  // Top-level channel posts deliberately leave `threadId` undefined — the
  // gateway then routes to the unthreaded `${platform}:${botKey}:${chatId}`
  // lane. Threaded posts set `threadId = thread_ts` for per-thread isolation.
  // No sentinel value: keeping `'top'` (or any platform-specific string) on
  // the generic `InboundMessage` contract would leak Slack's lane policy
  // into every future adapter.
  return {
    platform: 'slack',
    botKey: input.botKey,
    chatId: input.channel,
    userId: input.userId,
    text: input.text,
    isDm: input.isDm,
    isGroupMention: input.isGroupMention,
    replyToId: input.threadTs,
    messageId: input.ts,
    ...(input.threadTs ? { threadId: input.threadTs } : {}),
    raw: input.raw,
  };
}
/** Remove every `<@USERID>` mention so the agent sees the plain message text. */
export function stripMentions(text) {
  return text.replace(/<@[A-Z0-9]+>/g, '');
}
