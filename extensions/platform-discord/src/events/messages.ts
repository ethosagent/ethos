import type { Attachment, AttachmentCache, InboundMessage } from '@ethosagent/types';
import type { Client, Message } from 'discord.js';
import type { ChannelMode } from '../config';
import { shouldRespond } from '../routing/channel-mode';
import type { ChannelOverrideStore } from '../store/channel-overrides';
import type { ThreadStateStore } from '../store/thread-state';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const SKIP_EXTS = new Set(['exe', 'dll', 'so', 'dylib']);

interface MessageContext {
  client: Client;
  botKey: string;
  mentionOnly: boolean;
  defaultChannelMode: ChannelMode;
  receiptReaction: string;
  cache?: AttachmentCache;
  channelOverrides?: ChannelOverrideStore;
  threadState?: ThreadStateStore;
  onMessage: (msg: InboundMessage) => void;
  onReceipt: (channelId: string, messageId: string) => void;
}

export function registerMessageHandler(ctx: MessageContext): void {
  ctx.client.on('messageCreate', (message: Message) => {
    if (message.author.bot) return;

    const isDm = message.channel.isDMBased();
    const isMention = ctx.client.user ? message.mentions.has(ctx.client.user) : false;
    const isThread = message.channel.isThread();

    const channelId = isThread
      ? (message.channel.parentId ?? message.channelId)
      : message.channelId;
    const threadId = isThread ? message.channelId : undefined;

    const channelMode = resolveMode(channelId, ctx);
    const hasBotPosted =
      threadId && ctx.threadState ? ctx.threadState.hasBotPosted(channelId, threadId) : false;

    const responds = shouldRespond({
      isDm,
      isGroupMention: isMention && !isDm,
      channelMode,
      hasBotPosted,
    });

    if (!responds && ctx.mentionOnly && !isDm && !isMention) return;
    if (!responds) return;

    let text = message.content;
    if (ctx.client.user) {
      text = text.replace(new RegExp(`<@!?${ctx.client.user.id}>`, 'g'), '').trim();
    }

    // Receipt reaction (best-effort, non-blocking)
    if (ctx.receiptReaction) {
      message.react(ctx.receiptReaction).catch(() => {});
      ctx.onReceipt(message.channelId, message.id);
    }

    const msg: InboundMessage = {
      platform: 'discord',
      botKey: ctx.botKey,
      chatId: channelId,
      userId: message.author.id,
      username: message.author.username,
      text,
      isDm,
      isGroupMention: isMention && !isDm,
      replyToId: message.reference?.messageId ?? undefined,
      replyToUserId: undefined,
      messageId: message.id,
      threadId,
      raw: message,
    };

    if (message.attachments.size === 0 || !ctx.cache) {
      ctx.onMessage(msg);
      return;
    }

    void downloadAttachments(message, ctx.cache).then((attachments) => {
      if (attachments.length > 0) {
        msg.attachments = attachments;
        if (!msg.text) {
          msg.text = attachments[0].type === 'image' ? '(attached image)' : '(attached file)';
        }
      }
      ctx.onMessage(msg);
    });
  });
}

function resolveMode(channelId: string, ctx: MessageContext): ChannelMode {
  const override = ctx.channelOverrides?.get(channelId);
  return override ?? ctx.defaultChannelMode;
}

async function downloadAttachments(
  message: Message,
  cache: AttachmentCache,
): Promise<Attachment[]> {
  const results: Attachment[] = [];

  for (const [, attachment] of message.attachments) {
    if (attachment.size > MAX_FILE_SIZE) continue;

    const ext = attachment.name?.split('.').pop()?.toLowerCase() ?? '';
    if (SKIP_EXTS.has(ext)) continue;

    const type: Attachment['type'] = IMAGE_EXTS.has(ext) ? 'image' : 'file';
    const mimeType = attachment.contentType ?? 'application/octet-stream';

    try {
      const resp = await fetch(attachment.url);
      if (!resp.ok) continue;
      const buffer = Buffer.from(await resp.arrayBuffer());
      const filename = attachment.name ?? 'attachment';
      const url = await cache.write(buffer, {
        sessionKey: '',
        messageId: message.id,
        filename,
        mime: mimeType,
      });
      results.push({
        type,
        ref: attachment.url,
        url,
        mimeType,
        filename,
        sizeBytes: buffer.length,
      });
    } catch {
      // best-effort download
    }
  }

  return results;
}
