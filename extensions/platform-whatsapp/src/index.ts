import type {
  AdapterCapabilities,
  AttachmentCache,
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { downloadMedia } from './media';
import { hasMedia, parseInboundMessage, type RawWhatsAppMessage } from './message-parser';
import { resolveSessionDir } from './session-store';

export interface WhatsAppAdapterConfig {
  id?: string;
  sessionDir: string;
  defaultMode?: 'all' | 'mention_only';
  allowedJids?: string[];
  cache?: AttachmentCache;
  onQr?: (qr: string | null) => void;
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
  private reconnecting = false;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private messageHandler?: (message: InboundMessage) => void;
  private botJid = '';
  private readonly config: WhatsAppAdapterConfig;
  private readonly pendingReactions = new Map<string, string>();

  constructor(config: WhatsAppAdapterConfig) {
    this.config = config;
    this.botKey = config.id ?? `wa-${config.sessionDir.replace(/[^a-zA-Z0-9]/g, '').slice(-16)}`;
    this.id = `whatsapp:${this.botKey}`;
  }

  async start(): Promise<void> {
    if (this.reconnecting) return;
    this.stopped = false;

    const sessionDir = resolveSessionDir({
      sessionDir: this.config.sessionDir,
      botKey: this.botKey,
    });

    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.makeWASocket ?? baileys.default;
    const { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      getMessage: async () => undefined,
    });

    sock.ev.on('creds.update', saveCreds);

    // biome-ignore lint/suspicious/noExplicitAny: Baileys ConnectionState type varies across versions
    sock.ev.on('connection.update', (update: any) => {
      if (update.qr) {
        import('qrcode-terminal')
          .then((qrterm) => {
            qrterm.generate(update.qr, { small: true });
          })
          .catch(() => {
            // qrcode-terminal unavailable; printQRInTerminal handles it
          });
        if (this.config.onQr) this.config.onQr(update.qr);
      }

      if (update.connection === 'close') {
        const code = update.lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut && !this.stopped) {
          this.reconnecting = true;
          this.sock = null;
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.reconnecting = false;
            this.start();
          }, 3000);
        }
      }

      if (update.connection === 'open') {
        this.botJid = sock.user?.id ?? '';
        if (this.config.onQr) this.config.onQr(null);
      }
    });

    // biome-ignore lint/suspicious/noExplicitAny: Baileys WAMessage type varies across versions
    sock.ev.on('messages.upsert', async (upsert: any) => {
      if (upsert.type !== 'notify') return;
      const messages = upsert.messages as RawWhatsAppMessage[];

      for (const msg of messages) {
        if (!this.messageHandler) continue;
        if (msg.key.fromMe) continue;

        const jid = msg.key.remoteJid ?? '';
        const isDm = !jid.endsWith('@g.us');

        if (this.config.allowedJids) {
          const checkJid = isDm ? jid : (msg.key.participant ?? '');
          const number = checkJid.split('@')[0].replace(/[^0-9]/g, '');
          const matched = this.config.allowedJids.some((allowed) => {
            const normalizedAllowed = allowed.replace(/[^0-9]/g, '');
            return number === normalizedAllowed;
          });
          if (!matched) continue;
        }

        if (!isDm && this.config.defaultMode === 'mention_only') {
          const text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? '';
          const botNumber = this.botJid.split('@')[0].split(':')[0];
          if (!text.includes(`@${botNumber}`)) continue;
        }

        let attachments: import('@ethosagent/types').Attachment[] | undefined;
        if (hasMedia(msg) && this.config.cache) {
          const sessionKey = `whatsapp:${this.botKey}:${jid}`;
          try {
            const att = await downloadMedia(
              msg,
              async (m) => {
                // biome-ignore lint/suspicious/noExplicitAny: Baileys downloadMediaMessage signature varies across versions
                const buffer = await (downloadMediaMessage as any)(m, 'buffer', {});
                return Buffer.from(buffer);
              },
              this.config.cache,
              sessionKey,
            );
            if (att) attachments = [att];
          } catch {
            // best-effort media download
          }
        }

        const parsed = parseInboundMessage(msg, this.botJid, this.botKey, attachments);
        if (!parsed) continue;

        // Receipt reaction
        try {
          await (
            sock as {
              sendMessage: (jid: string, content: unknown) => Promise<unknown>;
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
    });

    this.sock = sock;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;
    if (this.sock) {
      const sock = this.sock as {
        end: (reason?: unknown) => void;
      };
      sock.end(undefined);
      this.sock = null;
    }
  }

  async send(chatId: string, message: OutboundMessage): Promise<DeliveryResult> {
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

        const sent = await sock.sendMessage(chatId, { text: chunk }, opts);
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
