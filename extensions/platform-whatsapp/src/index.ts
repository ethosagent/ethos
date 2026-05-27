import type {
  PlatformAdapter,
  InboundMessage,
  OutboundMessage,
  DeliveryResult,
  AttachmentCache,
  AdapterCapabilities,
} from '@ethosagent/types';
import {
  parseInboundMessage,
  hasMedia,
  type RawWhatsAppMessage,
} from './message-parser';
import { downloadMedia } from './media';
import { resolveSessionDir } from './session-store';

export interface WhatsAppAdapterConfig {
  id?: string;
  sessionDir: string;
  defaultMode?: 'all' | 'mention_only';
  allowedJids?: string[];
  cache?: AttachmentCache;
}

export class WhatsAppAdapter implements PlatformAdapter {
  readonly id: string;
  readonly displayName = 'WhatsApp';
  readonly canSendTyping = false;
  readonly canEditMessage = false;
  readonly canReact = true;
  readonly canSendFiles = false;
  readonly maxMessageLength = 65536;
  readonly capabilities: AdapterCapabilities = {
    platform: 'whatsapp',
    channelModes: true,
  };

  readonly botKey: string;
  private sock: unknown = null;
  private messageHandler?: (message: InboundMessage) => void;
  private botJid = '';
  private readonly config: WhatsAppAdapterConfig;
  private readonly pendingReactions = new Map<string, string>();

  constructor(config: WhatsAppAdapterConfig) {
    this.config = config;
    this.botKey = config.id ?? `wa-${Date.now()}`;
    this.id = `whatsapp:${this.botKey}`;
  }

  async start(): Promise<void> {
    const sessionDir = resolveSessionDir({
      sessionDir: this.config.sessionDir,
      botKey: this.botKey,
    });

    const baileys = await import('@whiskeysockets/baileys');
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
    } = baileys;

    const { state, saveCreds } =
      await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on(
      'connection.update',
      (update: {
        connection?: string;
        lastDisconnect?: {
          error?: { output?: { statusCode?: number } };
        };
        qr?: string;
      }) => {
        if (update.qr) {
          try {
            const qrterm = require('qrcode-terminal');
            qrterm.generate(update.qr, { small: true });
          } catch {
            console.log('[whatsapp] QR code:', update.qr);
          }
        }

        if (update.connection === 'close') {
          const code =
            update.lastDisconnect?.error?.output?.statusCode;
          if (code !== DisconnectReason.loggedOut) {
            this.start();
          }
        }

        if (update.connection === 'open') {
          this.botJid = sock.user?.id ?? '';
          console.log(`[whatsapp] Connected as ${this.botJid}`);
        }
      },
    );

    sock.ev.on(
      'messages.upsert',
      async (upsert: {
        messages: RawWhatsAppMessage[];
        type: string;
      }) => {
        if (upsert.type !== 'notify') return;

        for (const msg of upsert.messages) {
          if (!this.messageHandler) continue;
          if (msg.key.fromMe) continue;

          const jid = msg.key.remoteJid ?? '';
          const isDm = !jid.endsWith('@g.us');

          if (this.config.allowedJids && isDm) {
            const normalized = jid.replace(
              '@s.whatsapp.net',
              '',
            );
            if (
              !this.config.allowedJids.some((j) =>
                normalized.includes(j.replace('+', '')),
              )
            ) {
              continue;
            }
          }

          if (!isDm && this.config.defaultMode === 'mention_only') {
            const text =
              msg.message?.conversation ??
              msg.message?.extendedTextMessage?.text ??
              '';
            const botNumber = this.botJid
              .split('@')[0]
              .split(':')[0];
            if (!text.includes(`@${botNumber}`)) continue;
          }

          let attachments:
            | import('@ethosagent/types').Attachment[]
            | undefined;
          if (hasMedia(msg) && this.config.cache) {
            const sessionKey = `whatsapp:${this.botKey}:${jid}`;
            try {
              const att = await downloadMedia(
                msg,
                async (m) => {
                  const stream = await (
                    sock as {
                      downloadMediaMessage: (
                        m: unknown,
                      ) => Promise<Buffer>;
                    }
                  ).downloadMediaMessage(m);
                  return stream;
                },
                this.config.cache,
                sessionKey,
              );
              if (att) attachments = [att];
            } catch {
              // best-effort media download
            }
          }

          const parsed = parseInboundMessage(
            msg,
            this.botJid,
            this.botKey,
            attachments,
          );
          if (!parsed) continue;

          // Receipt reaction
          try {
            await (
              sock as {
                sendMessage: (
                  jid: string,
                  content: unknown,
                ) => Promise<unknown>;
              }
            ).sendMessage(jid, {
              react: { text: '\u{1F440}', key: msg.key },
            });
            this.pendingReactions.set(jid, msg.key.id ?? '');
          } catch {
            // best-effort reaction
          }

          this.messageHandler(parsed);
        }
      },
    );

    this.sock = sock;
  }

  async stop(): Promise<void> {
    if (this.sock) {
      const sock = this.sock as {
        end: (reason?: unknown) => void;
      };
      sock.end(undefined);
      this.sock = null;
    }
  }

  async send(
    chatId: string,
    message: OutboundMessage,
  ): Promise<DeliveryResult> {
    if (!this.sock) return { ok: false, error: 'Not connected' };

    const sock = this.sock as {
      sendMessage: (
        jid: string,
        content: unknown,
        opts?: unknown,
      ) => Promise<{ key: { id?: string } }>;
    };

    const text = message.text;
    const chunks = chunkText(text, this.maxMessageLength);

    let firstId: string | undefined;
    for (const chunk of chunks) {
      try {
        const opts = message.replyToId
          ? {
              quoted: {
                key: { remoteJid: chatId, id: message.replyToId },
              },
            }
          : undefined;

        const sent = await sock.sendMessage(
          chatId,
          { text: chunk },
          opts,
        );
        if (!firstId) firstId = sent.key.id;
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Clear receipt reaction
    const pendingId = this.pendingReactions.get(chatId);
    if (pendingId) {
      try {
        await sock.sendMessage(chatId, {
          react: {
            text: '',
            key: { remoteJid: chatId, id: pendingId },
          },
        });
      } catch {
        // best-effort
      }
      this.pendingReactions.delete(chatId);
    }

    return { ok: true, messageId: firstId };
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  async health(): Promise<{ ok: boolean; latencyMs?: number }> {
    return { ok: this.sock !== null && this.botJid !== '' };
  }
}

function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}
