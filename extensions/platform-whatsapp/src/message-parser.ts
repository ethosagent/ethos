import type { Attachment, InboundMessage } from '@ethosagent/types';

export interface RawWhatsAppMessage {
  key: {
    remoteJid: string | null | undefined;
    fromMe: boolean;
    id: string;
    participant?: string;
  };
  pushName?: string;
  message?: {
    conversation?: string;
    extendedTextMessage?: {
      text?: string;
      contextInfo?: {
        quotedMessage?: unknown;
        stanzaId?: string;
        mentionedJid?: string[];
      };
    };
    imageMessage?: {
      mimetype?: string;
      caption?: string;
      fileLength?: number;
    };
    documentMessage?: {
      mimetype?: string;
      fileName?: string;
      fileLength?: number;
    };
    audioMessage?: { mimetype?: string; fileLength?: number };
    videoMessage?: {
      mimetype?: string;
      caption?: string;
      fileLength?: number;
    };
  };
  messageTimestamp?: number;
}

export function parseInboundMessage(
  msg: RawWhatsAppMessage,
  botJid: string,
  botKey: string,
  attachments?: Attachment[],
): InboundMessage | null {
  if (msg.key.fromMe) return null;

  const jid = msg.key.remoteJid ?? '';
  const isDm = !jid.endsWith('@g.us');
  const text = extractText(msg);
  const botNumber = botJid.split('@')[0].split(':')[0];
  const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  const isGroupMention =
    !isDm &&
    ((mentionedJids && mentionedJids.some((j) => j.split('@')[0].split(':')[0] === botNumber)) ||
      text.includes(`@${botNumber}`));

  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;

  return {
    platform: 'whatsapp',
    chatId: jid,
    userId: msg.key.participant ?? jid,
    username: msg.pushName ?? undefined,
    text,
    attachments,
    replyToId: contextInfo?.stanzaId ?? undefined,
    isDm,
    isGroupMention,
    messageId: msg.key.id ?? undefined,
    botKey,
    raw: msg,
  };
}

function extractText(msg: RawWhatsAppMessage): string {
  if (msg.message?.conversation) return msg.message.conversation;
  if (msg.message?.extendedTextMessage?.text) return msg.message.extendedTextMessage.text;
  if (msg.message?.imageMessage?.caption) return msg.message.imageMessage.caption;
  if (msg.message?.videoMessage?.caption) return msg.message.videoMessage.caption;
  return '';
}

export function hasMedia(msg: RawWhatsAppMessage): boolean {
  const m = msg.message;
  return !!(m?.imageMessage || m?.documentMessage || m?.audioMessage || m?.videoMessage);
}

export function getMediaMeta(
  msg: RawWhatsAppMessage,
): { mime: string; filename: string; type: 'image' | 'file' } | null {
  const m = msg.message;
  if (m?.imageMessage) {
    return {
      mime: m.imageMessage.mimetype ?? 'image/jpeg',
      filename: 'image.jpg',
      type: 'image',
    };
  }
  if (m?.documentMessage) {
    return {
      mime: m.documentMessage.mimetype ?? 'application/octet-stream',
      filename: m.documentMessage.fileName ?? 'document',
      type: 'file',
    };
  }
  if (m?.audioMessage) {
    return {
      mime: m.audioMessage.mimetype ?? 'audio/ogg',
      filename: 'audio.ogg',
      type: 'file',
    };
  }
  if (m?.videoMessage) {
    return {
      mime: m.videoMessage.mimetype ?? 'video/mp4',
      filename: 'video.mp4',
      type: 'file',
    };
  }
  return null;
}
