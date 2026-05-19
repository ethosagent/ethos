import type { Attachment, AttachmentCache, InboundMessage } from '@ethosagent/types';
import type { Client, Message } from 'discord.js';
import type { ChannelMode } from '../config';
import type { TriageContext } from '../routing/triage';
import { triageMessage } from '../routing/triage';
import type { ChannelOverrideStore } from '../store/channel-overrides';
import type { ThreadStateStore } from '../store/thread-state';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

/** Known Discord CDN hosts for attachment downloads. */
const DISCORD_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
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
  ctx.client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;

    const isDm = message.channel.isDMBased();
    const isMention = ctx.client.user ? message.mentions.has(ctx.client.user) : false;
    const isThread = message.channel.isThread();

    let text = message.content;
    if (ctx.client.user) {
      text = text.replace(new RegExp(`<@!?${ctx.client.user.id}>`, 'g'), '').trim();
    }

    const triageCtx: TriageContext = {
      botKey: ctx.botKey,
      defaultChannelMode: ctx.defaultChannelMode,
      channelOverrides: ctx.channelOverrides,
      threadState: ctx.threadState,
    };

    const result = await triageMessage(
      {
        channelId: message.channelId,
        userId: message.author.id,
        username: message.author.username,
        text,
        messageId: message.id,
        isDm,
        isThread,
        threadId: isThread ? message.channelId : undefined,
        parentChannelId: isThread ? (message.channel.parentId ?? undefined) : undefined,
        isMention: isMention && !isDm,
        reference: {
          messageId: message.reference?.messageId ?? undefined,
          userId: message.mentions.repliedUser?.id ?? undefined,
        },
        raw: message,
      },
      triageCtx,
    );

    if (!result.envelope) return;

    // Populate replyToId/replyToUserId from the reference
    const envelope = result.envelope;
    if (message.reference?.messageId) {
      envelope.replyToId = message.reference.messageId;
    }
    if (message.mentions.repliedUser?.id) {
      envelope.replyToUserId = message.mentions.repliedUser.id;
    }

    // Receipt reaction (best-effort, non-blocking)
    if (ctx.receiptReaction) {
      message.react(ctx.receiptReaction).catch(() => {});
      ctx.onReceipt(message.channelId, message.id);
    }

    if (message.attachments.size === 0 || !ctx.cache) {
      ctx.onMessage(envelope);
      return;
    }

    const attachments = await downloadAttachments(message, ctx.cache);
    if (attachments.length > 0) {
      envelope.attachments = attachments;
      if (!envelope.text) {
        envelope.text = attachments[0].type === 'image' ? '(attached image)' : '(attached file)';
      }
    }
    ctx.onMessage(envelope);
  });
}

function classifyAttachmentType(
  contentType: string | null,
  filename: string | undefined,
): 'image' | 'file' {
  // Trust contentType first when available
  if (contentType && IMAGE_CONTENT_TYPES.has(contentType)) return 'image';
  // Fall back to extension
  const ext = filename?.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  return 'file';
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

    const mimeType = attachment.contentType ?? 'application/octet-stream';
    const type = classifyAttachmentType(attachment.contentType, attachment.name ?? undefined);

    try {
      // SSRF gate: only fetch from known Discord CDN hosts
      let attachmentHost: string;
      try {
        attachmentHost = new URL(attachment.url).hostname.toLowerCase();
      } catch {
        continue;
      }
      if (!DISCORD_CDN_HOSTS.has(attachmentHost)) continue;

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
