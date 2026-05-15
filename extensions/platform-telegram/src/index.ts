import { createHash } from 'node:crypto';
import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { Bot, InlineKeyboard } from 'grammy';

// ---------------------------------------------------------------------------
// Clarify interactive shapes — used by the Telegram clarify surface to post
// inline-keyboard prompts and force-reply prompts. Defined here so the
// surface module depends on a structural shape on the adapter rather than
// reaching into grammy itself.
// ---------------------------------------------------------------------------

/** One button in an inline keyboard row. */
export interface InlineButton {
  label: string;
  /** Telegram `callback_data` — must be 1..64 bytes UTF-8. */
  data: string;
}

/** Inbound callback-query event surfaced to the clarify surface. */
export interface CallbackQueryEvent {
  /** Telegram callback_query id — used to dismiss the spinner. */
  queryId: string;
  data: string;
  chatId: string;
  /** Message id of the keyboard the user tapped (the prompt). */
  messageId: string;
  userId: string | undefined;
  username: string | undefined;
  /** Dismiss the loading spinner on the button. Idempotent best-effort. */
  answer: (text?: string) => Promise<void>;
}

// First 24 hex chars of sha256(token). Matches the derivation in
// `apps/ethos/src/config.ts:deriveBotKey` so an adapter constructed
// directly (without going through the gateway boot path) ends up with
// the same routing identity it would have if the operator had wired
// it through `telegram.bots[]`. 96 bits is wide enough that collision
// is cosmologically unlikely.
function deriveDefaultBotKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 24);
}

// ---------------------------------------------------------------------------
// Text chunking — Telegram has a 4096 char limit per message
// ---------------------------------------------------------------------------

export function chunkText(text: string, maxLength = 4096): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Prefer breaking at a newline, then a space
    let cutAt = maxLength;
    const newlineAt = remaining.lastIndexOf('\n', maxLength);
    if (newlineAt > maxLength * 0.6) {
      cutAt = newlineAt + 1;
    } else {
      const spaceAt = remaining.lastIndexOf(' ', maxLength);
      if (spaceAt > maxLength * 0.6) cutAt = spaceAt + 1;
    }

    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt);
  }

  return chunks;
}

/**
 * Re-flow `newChunks` over `existingIds`. Edits the first N chunks in place,
 * appends extras, and deletes trailing existing chunks no longer needed.
 * Delete failures are swallowed (best-effort).
 */
export async function reflowChunks(
  newChunks: string[],
  existingIds: string[],
  ops: {
    edit: (id: string, text: string) => Promise<string>;
    append: (text: string) => Promise<string>;
    deleteId: (id: string) => Promise<void>;
  },
): Promise<string[]> {
  const updated: string[] = [];
  for (let i = 0; i < newChunks.length; i++) {
    if (i < existingIds.length) {
      updated.push(await ops.edit(existingIds[i], newChunks[i]));
    } else {
      updated.push(await ops.append(newChunks[i]));
    }
  }
  for (let i = newChunks.length; i < existingIds.length; i++) {
    try {
      await ops.deleteId(existingIds[i]);
    } catch {
      // best-effort delete
    }
  }
  return updated;
}

// ---------------------------------------------------------------------------
// TelegramAdapter
// ---------------------------------------------------------------------------

export interface TelegramAdapterConfig {
  token: string;
  /**
   * Stable identifier of the bot this adapter is bound to. Stamped on every
   * inbound `InboundMessage.botKey` so the Gateway can route to the right
   * `AgentLoop` in multi-bot deployments. Optional: when omitted the
   * adapter derives the same 24-hex sha256(token) prefix the config
   * layer's `deriveBotKey()` produces, so a direct constructor call
   * without `botKey` round-trips with the same identity the boot path
   * would have produced from the same token.
   */
  botKey?: string;
  /** Whether to drop updates that arrived while the bot was offline. Default true. */
  dropPendingUpdates?: boolean;
}

export class TelegramAdapter implements PlatformAdapter {
  readonly id: string;
  readonly displayName = 'Telegram';
  readonly canSendTyping = true;
  readonly canEditMessage = true;
  readonly canReact = false;
  readonly canSendFiles = false;
  readonly maxMessageLength = 4096;

  readonly botKey: string;
  private readonly bot: Bot;
  private readonly dropPendingUpdates: boolean;
  private messageHandler?: (message: InboundMessage) => void;
  /** Registered by the clarify surface to receive inline-keyboard taps. */
  private callbackQueryHandler?: (event: CallbackQueryEvent) => void;
  /** Chunk-id ledger so editMessage can re-flow multi-chunk responses. */
  private readonly chunkMap = new Map<string, string[]>();
  private readonly chunkMapMaxEntries = 1024;

  constructor(config: TelegramAdapterConfig) {
    this.bot = new Bot(config.token);
    this.dropPendingUpdates = config.dropPendingUpdates ?? true;
    this.botKey = config.botKey ?? deriveDefaultBotKey(config.token);
    // Multi-bot logs disambiguate by including the botKey. Single-bot
    // deployments pass 'default' (or omit and let the derived hash
    // stand in) and see `telegram:<key>` — the shape is identical, the
    // value carries the routing identity.
    this.id = `telegram:${this.botKey}`;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    this.bot.on('message', (ctx) => {
      if (!this.messageHandler) return;

      const text = ctx.message.text ?? ctx.message.caption ?? '';
      if (!text) return;

      const msg: InboundMessage = {
        platform: 'telegram',
        botKey: this.botKey,
        chatId: String(ctx.chat.id),
        userId: ctx.from ? String(ctx.from.id) : undefined,
        username: ctx.from?.username,
        text,
        isDm: ctx.chat.type === 'private',
        isGroupMention: ctx.message.text?.includes(`@${ctx.me.username}`) ?? false,
        messageId: String(ctx.message.message_id),
        replyToId: ctx.message.reply_to_message
          ? String(ctx.message.reply_to_message.message_id)
          : undefined,
        replyToUserId: ctx.message.reply_to_message?.from
          ? String(ctx.message.reply_to_message.from.id)
          : undefined,
        raw: ctx,
      };

      this.messageHandler(msg);
    });

    // Inline-keyboard taps arrive as `callback_query` updates — a separate
    // channel from `message`. The clarify surface registers via
    // `onCallbackQuery()`; we surface only the minimal envelope it needs so
    // it doesn't depend on grammy directly.
    this.bot.on('callback_query:data', (ctx) => {
      if (!this.callbackQueryHandler) return;
      const cq = ctx.callbackQuery;
      const messageId = cq.message?.message_id;
      const chatId = cq.message?.chat?.id;
      if (messageId === undefined || chatId === undefined) return;
      this.callbackQueryHandler({
        queryId: cq.id,
        data: cq.data,
        chatId: String(chatId),
        messageId: String(messageId),
        userId: cq.from ? String(cq.from.id) : undefined,
        username: cq.from?.username,
        answer: async (text) => {
          await ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {});
        },
      });
    });

    // Non-blocking: bot.start() runs the polling loop in the background.
    // grammy's start() rejects on init failure (e.g. invalid token → getMe 404)
    // and on terminal polling errors. Without a .catch() the rejection becomes
    // an unhandled promise rejection, which Node 24 treats as fatal — killing
    // the whole gateway and any other adapters running with it. Attach a
    // handler so a bad Telegram token degrades to a logged warning instead.
    this.bot.start({ drop_pending_updates: this.dropPendingUpdates }).catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[telegram] bot polling stopped: ${detail}`);
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Register a handler for inline-keyboard taps (callback queries). Used by
   * the Telegram clarify surface to receive button clicks; not part of the
   * cross-platform `PlatformAdapter` contract.
   */
  onCallbackQuery(handler: (event: CallbackQueryEvent) => void): void {
    this.callbackQueryHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  async send(chatId: string, message: OutboundMessage): Promise<DeliveryResult> {
    const chunks = chunkText(message.text, this.maxMessageLength);
    const ids: string[] = [];

    for (const chunk of chunks) {
      try {
        const sent = await this.bot.api.sendMessage(Number(chatId), chunk, {
          parse_mode: message.parseMode === 'html' ? 'HTML' : 'Markdown',
          reply_parameters: message.replyToId
            ? { message_id: Number(message.replyToId) }
            : undefined,
        });
        ids.push(String(sent.message_id));
      } catch (err) {
        // Markdown parse errors — retry as plain text
        if (String(err).includes('parse')) {
          const sent = await this.bot.api.sendMessage(Number(chatId), chunk).catch(() => null);
          if (sent) ids.push(String(sent.message_id));
        } else {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }

    this.rememberChunkIds(ids);
    return { ok: true, messageId: ids[0] };
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.bot.api.sendChatAction(Number(chatId), 'typing').catch(() => {});
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<DeliveryResult> {
    try {
      const newChunks = chunkText(text, this.maxMessageLength);
      const existingIds = this.chunkMap.get(messageId) ?? [messageId];

      const updatedIds = await reflowChunks(newChunks, existingIds, {
        edit: async (id, chunk) => {
          await this.bot.api.editMessageText(Number(chatId), Number(id), chunk, {
            parse_mode: 'Markdown',
          });
          return id;
        },
        append: async (chunk) => {
          const sent = await this.bot.api.sendMessage(Number(chatId), chunk, {
            parse_mode: 'Markdown',
          });
          return String(sent.message_id);
        },
        deleteId: async (id) => {
          await this.bot.api.deleteMessage(Number(chatId), Number(id));
        },
      });

      this.chunkMap.delete(messageId);
      this.rememberChunkIds(updatedIds);
      return { ok: true, messageId: updatedIds[0] };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private rememberChunkIds(ids: string[]): void {
    if (ids.length === 0) return;
    const primary = ids[0];
    while (this.chunkMap.size >= this.chunkMapMaxEntries && !this.chunkMap.has(primary)) {
      const oldestKey = this.chunkMap.keys().next().value;
      if (oldestKey === undefined) break;
      this.chunkMap.delete(oldestKey);
    }
    this.chunkMap.set(primary, ids);
  }

  async health(): Promise<{ ok: boolean; latencyMs?: number }> {
    const start = Date.now();
    try {
      await this.bot.api.getMe();
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false };
    }
  }

  // ---------------------------------------------------------------------------
  // Clarify interactive sends — used by the Telegram clarify surface. Not on
  // the cross-platform `PlatformAdapter` contract; the surface treats the
  // adapter structurally.
  // ---------------------------------------------------------------------------

  /**
   * Send a message with an inline keyboard. `rows` is row-major: each inner
   * array is one row of buttons. Returns the message id so the surface can
   * later edit it in place to the resolved state.
   */
  async sendInlineKeyboard(
    chatId: string,
    text: string,
    rows: InlineButton[][],
  ): Promise<DeliveryResult> {
    try {
      const kb = new InlineKeyboard();
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        if (!row) continue;
        for (const btn of row) kb.text(btn.label, btn.data);
        if (r < rows.length - 1) kb.row();
      }
      const sent = await this.bot.api.sendMessage(Number(chatId), text, {
        reply_markup: kb,
      });
      return { ok: true, messageId: String(sent.message_id) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Send a force-reply prompt. Telegram clients auto-open the user's keyboard
   * with a "Replying to..." indicator; the inbound reply's `replyToId` is the
   * id returned here, which the surface uses to correlate.
   */
  async sendForceReply(chatId: string, text: string): Promise<DeliveryResult> {
    try {
      const sent = await this.bot.api.sendMessage(Number(chatId), text, {
        reply_markup: { force_reply: true, selective: true },
      });
      return { ok: true, messageId: String(sent.message_id) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Edit a previously-sent prompt to a plain-text resolved state, stripping
   * any inline keyboard. Used when a clarify is answered, times out, or is
   * cancelled — the buttons go away and the message reads e.g.
   * "Which database? → postgres".
   */
  async editToPlainText(chatId: string, messageId: string, text: string): Promise<DeliveryResult> {
    try {
      await this.bot.api.editMessageText(Number(chatId), Number(messageId), text, {
        reply_markup: { inline_keyboard: [] },
      });
      return { ok: true, messageId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
