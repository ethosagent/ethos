import { createHash } from 'node:crypto';
import type {
  ApprovalCapableAdapter,
  ApprovalDecisionEvent,
  Attachment,
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { Bot, InlineKeyboard } from 'grammy';
import { chunkHash, markdownToTelegramHtml } from './format';

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

// grammy's ReactionTypeEmoji.emoji is a strict union of specific emoji
// literals. We define a type alias so config strings can be cast cleanly.
type TelegramEmoji = '👀';

// ---------------------------------------------------------------------------
// Truncation utility — BotFather fields have strict char limits
// ---------------------------------------------------------------------------

export function truncateWithEllipsis(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
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
// Media helpers — detect + download inbound file attachments
// ---------------------------------------------------------------------------

/** Maximum file size in bytes that we'll download into memory. */
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

interface MediaDescriptor {
  fileId: string;
  type: Attachment['type'];
  mimeType: string;
  filename?: string;
  fileSize?: number;
}

/** Map Telegram media type placeholders for captionless messages. */
const MEDIA_PLACEHOLDER: Record<Attachment['type'], string> = {
  image: '(attached image)',
  file: '(attached file)',
  audio: '(attached audio)',
  video: '(attached video)',
};

/**
 * Extract media descriptors from a Telegram message object.
 * Checks photo, document, voice, audio, video, animation, sticker in priority order.
 * Returns an empty array when the message has no media.
 */
function extractMedia(msg: Record<string, unknown>): MediaDescriptor[] {
  const results: MediaDescriptor[] = [];

  // photo → array of PhotoSize; pick the last (highest resolution)
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1] as Record<string, unknown>;
    results.push({
      fileId: String(largest.file_id),
      type: 'image',
      mimeType: 'image/jpeg',
      fileSize: typeof largest.file_size === 'number' ? largest.file_size : undefined,
    });
  }

  // document
  if (msg.document && typeof msg.document === 'object') {
    const doc = msg.document as Record<string, unknown>;
    results.push({
      fileId: String(doc.file_id),
      type: 'file',
      mimeType: typeof doc.mime_type === 'string' ? doc.mime_type : 'application/octet-stream',
      filename: typeof doc.file_name === 'string' ? doc.file_name : undefined,
      fileSize: typeof doc.file_size === 'number' ? doc.file_size : undefined,
    });
  }

  // voice
  if (msg.voice && typeof msg.voice === 'object') {
    const v = msg.voice as Record<string, unknown>;
    results.push({
      fileId: String(v.file_id),
      type: 'audio',
      mimeType: typeof v.mime_type === 'string' ? v.mime_type : 'audio/ogg',
      fileSize: typeof v.file_size === 'number' ? v.file_size : undefined,
    });
  }

  // audio
  if (msg.audio && typeof msg.audio === 'object') {
    const a = msg.audio as Record<string, unknown>;
    results.push({
      fileId: String(a.file_id),
      type: 'audio',
      mimeType: typeof a.mime_type === 'string' ? a.mime_type : 'audio/mpeg',
      filename: typeof a.file_name === 'string' ? a.file_name : undefined,
      fileSize: typeof a.file_size === 'number' ? a.file_size : undefined,
    });
  }

  // video
  if (msg.video && typeof msg.video === 'object') {
    const v = msg.video as Record<string, unknown>;
    results.push({
      fileId: String(v.file_id),
      type: 'video',
      mimeType: typeof v.mime_type === 'string' ? v.mime_type : 'video/mp4',
      fileSize: typeof v.file_size === 'number' ? v.file_size : undefined,
    });
  }

  // animation (GIF)
  if (msg.animation && typeof msg.animation === 'object') {
    const a = msg.animation as Record<string, unknown>;
    results.push({
      fileId: String(a.file_id),
      type: 'video',
      mimeType: typeof a.mime_type === 'string' ? a.mime_type : 'video/mp4',
      fileSize: typeof a.file_size === 'number' ? a.file_size : undefined,
    });
  }

  // sticker
  if (msg.sticker && typeof msg.sticker === 'object') {
    const s = msg.sticker as Record<string, unknown>;
    results.push({
      fileId: String(s.file_id),
      type: 'image',
      mimeType: 'image/webp',
      fileSize: typeof s.file_size === 'number' ? s.file_size : undefined,
    });
  }

  return results;
}

/**
 * Download a single file from the Telegram Bot API. Returns a Buffer on
 * success, null on failure. Best-effort — callers handle the null case.
 */
async function downloadTelegramFile(
  botApi: { getFile: (fileId: string) => Promise<{ file_path?: string; file_size?: number }> },
  token: string,
  descriptor: MediaDescriptor,
): Promise<{ data: Buffer; fileSize: number } | null> {
  try {
    const fileInfo = await botApi.getFile(descriptor.fileId);
    const fileSize = fileInfo.file_size ?? descriptor.fileSize ?? 0;

    if (fileSize > MAX_FILE_SIZE) return null;

    if (!fileInfo.file_path) return null;

    const url = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;

    const arrayBuf = await resp.arrayBuffer();
    return { data: Buffer.from(arrayBuf), fileSize };
  } catch {
    return null;
  }
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
  /**
   * Bot identity pushed to BotFather at start(). Personality-bound bots
   * populate this from the personality config so the Telegram profile
   * reflects the agent's name and description. Best-effort — failures
   * are swallowed. Omit for team bindings (don't change BotFather settings).
   */
  identity?: {
    name: string;
    shortDescription: string;
    description: string;
  };
  /**
   * Emoji reaction set on inbound messages to acknowledge receipt.
   * Cleared when the agent's reply lands. Default '👀'.
   */
  receiptReaction?: string;
  /**
   * How long after the original message an edit is still accepted for
   * re-processing (milliseconds). Edits outside this window are ignored.
   * Default 60 000 (60 seconds).
   */
  editWindowMs?: number;
  /**
   * Outbound parse mode. `'html'` (default) translates agent Markdown to
   * Telegram HTML. `'plain'` skips translation and HTML escaping entirely.
   */
  parseMode?: 'html' | 'plain';
}

export class TelegramAdapter implements PlatformAdapter, ApprovalCapableAdapter {
  readonly id: string;
  readonly displayName = 'Telegram';
  readonly canSendTyping = true;
  readonly canEditMessage = true;
  readonly canReact = true;
  readonly canSendFiles = false;
  readonly maxMessageLength = 4096;

  readonly botKey: string;
  private readonly bot: Bot;
  private readonly dropPendingUpdates: boolean;
  private readonly identity: TelegramAdapterConfig['identity'];
  private readonly receiptReaction: string;
  private readonly parseMode: 'html' | 'plain';
  private messageHandler?: (message: InboundMessage) => void;
  /** Registered by the clarify surface to receive inline-keyboard taps. */
  private callbackQueryHandler?: (event: CallbackQueryEvent) => void;
  /** Approval-card button-click handler, wired by the approval coordinator. */
  private approvalDecisionHandler?: (event: ApprovalDecisionEvent) => void;
  /** Chunk-id ledger so editMessage can re-flow multi-chunk responses. */
  private readonly chunkMap = new Map<string, string[]>();
  private readonly chunkMapMaxEntries = 1024;
  /** Tracks inbound message ids per chat for reaction clearing on reply. */
  private readonly pendingReactions = new Map<string, number>();
  private readonly editWindowMs: number;
  /** Anti-thrashing debounce timers for edited_message, keyed by messageId. */
  private readonly editDebounce = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: TelegramAdapterConfig) {
    this.bot = new Bot(config.token);
    this.dropPendingUpdates = config.dropPendingUpdates ?? true;
    this.botKey = config.botKey ?? deriveDefaultBotKey(config.token);
    this.identity = config.identity;
    this.receiptReaction = config.receiptReaction ?? '👀';
    this.editWindowMs = config.editWindowMs ?? 60_000;
    this.parseMode = config.parseMode ?? 'html';
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
    // --- Bot identity from personality (best-effort) ---
    if (this.identity) {
      const id = this.identity;
      await this.bot.api.setMyName(truncateWithEllipsis(id.name, 64)).catch(() => {});
      await this.bot.api
        .setMyShortDescription(truncateWithEllipsis(id.shortDescription, 120))
        .catch(() => {});
      await this.bot.api
        .setMyDescription(truncateWithEllipsis(id.description, 512))
        .catch(() => {});
    }

    // --- Commands menu (best-effort) ---
    await this.bot.api
      .setMyCommands([
        { command: 'start', description: 'Introduce the bot' },
        { command: 'new', description: 'Start a fresh session' },
        { command: 'help', description: 'Show available commands' },
        { command: 'personality', description: 'Show the bound personality' },
        { command: 'usage', description: 'Session tokens + cost' },
        { command: 'stop', description: 'Abort the current reply' },
      ])
      .catch(() => {});

    this.bot.on('message', (ctx) => {
      if (!this.messageHandler) return;

      const rawMsg = ctx.message as unknown as Record<string, unknown>;
      const media = extractMedia(rawMsg);
      const caption = (ctx.message.text ?? ctx.message.caption ?? '') as string;
      const hasMedia = media.length > 0;

      // A message with neither text nor media is unprocessable.
      if (!caption && !hasMedia) return;

      // For captionless media messages, use a type-appropriate placeholder.
      const text = caption || (hasMedia ? MEDIA_PLACEHOLDER[media[0].type] : '');

      const chatId = ctx.chat.id;
      const messageId = ctx.message.message_id;

      // --- Forum-mode topic isolation (3.2) ---
      const rawThreadId =
        typeof rawMsg.message_thread_id === 'number' ? rawMsg.message_thread_id : undefined;
      // General topic (id 1) is treated as no thread for backward compat.
      const threadId =
        rawThreadId !== undefined && rawThreadId !== 1 ? String(rawThreadId) : undefined;

      // --- Reaction on receipt (best-effort, non-blocking) ---
      const reaction = [{ type: 'emoji' as const, emoji: this.receiptReaction as TelegramEmoji }];
      this.bot.api.setMessageReaction(chatId, messageId, reaction).catch(() => {});
      this.pendingReactions.set(String(chatId), messageId);

      // --- Build initial message (attachments filled async below) ---
      const msg: InboundMessage = {
        platform: 'telegram',
        botKey: this.botKey,
        chatId: String(chatId),
        userId: ctx.from ? String(ctx.from.id) : undefined,
        username: ctx.from?.username,
        text,
        isDm: ctx.chat.type === 'private',
        isGroupMention: ctx.message.text?.includes(`@${ctx.me.username}`) ?? false,
        messageId: String(messageId),
        threadId,
        replyToId: ctx.message.reply_to_message
          ? String(ctx.message.reply_to_message.message_id)
          : undefined,
        replyToUserId: ctx.message.reply_to_message?.from
          ? String(ctx.message.reply_to_message.from.id)
          : undefined,
        raw: ctx,
      };

      if (!hasMedia) {
        this.messageHandler(msg);
        return;
      }

      // Async media download — best-effort. If download fails, forward
      // the message without attachments so the agent still sees the caption.
      void this.downloadAndAttach(msg, media).then((enriched) => {
        if (this.messageHandler) this.messageHandler(enriched);
      });
    });

    // --- edited_message handler (3.3) ---
    this.bot.on('edited_message', (ctx) => {
      if (!this.messageHandler) return;

      const rawMsg = ctx.editedMessage as unknown as Record<string, unknown>;
      const caption = (rawMsg.text ?? rawMsg.caption ?? '') as string;
      const media = extractMedia(rawMsg);
      const hasMedia = media.length > 0;

      if (!caption && !hasMedia) return;

      const text = caption || (hasMedia ? MEDIA_PLACEHOLDER[media[0].type] : '');

      const date = typeof rawMsg.date === 'number' ? rawMsg.date : 0;
      const editDate = typeof rawMsg.edit_date === 'number' ? rawMsg.edit_date : 0;
      const ageMs = (editDate - date) * 1000;

      // Reject edits outside the configured window.
      if (ageMs > this.editWindowMs) return;

      const chatId = ctx.chat.id;
      const messageId = typeof rawMsg.message_id === 'number' ? rawMsg.message_id : 0;

      // Forum-mode thread isolation
      const rawThreadId =
        typeof rawMsg.message_thread_id === 'number' ? rawMsg.message_thread_id : undefined;
      const threadId =
        rawThreadId !== undefined && rawThreadId !== 1 ? String(rawThreadId) : undefined;

      const msg: InboundMessage = {
        platform: 'telegram',
        botKey: this.botKey,
        chatId: String(chatId),
        userId: ctx.from ? String(ctx.from.id) : undefined,
        username: ctx.from?.username,
        text,
        isEdit: true,
        isDm: ctx.chat.type === 'private',
        isGroupMention: false,
        messageId: String(messageId),
        threadId,
        replyToId: rawMsg.reply_to_message
          ? String((rawMsg.reply_to_message as Record<string, unknown>).message_id)
          : undefined,
        raw: ctx,
      };

      // Anti-thrashing: debounce rapid edits for the same messageId (200ms).
      const debounceKey = `${chatId}:${messageId}`;
      const existing = this.editDebounce.get(debounceKey);
      if (existing) clearTimeout(existing);

      this.editDebounce.set(
        debounceKey,
        setTimeout(() => {
          this.editDebounce.delete(debounceKey);
          if (!hasMedia) {
            this.messageHandler?.(msg);
            return;
          }
          void this.downloadAndAttach(msg, media).then((enriched) => {
            this.messageHandler?.(enriched);
          });
        }, 200),
      );
    });

    // Inline-keyboard taps arrive as `callback_query` updates — a separate
    // channel from `message`. Route by callback_data prefix:
    //   clr:*         → clarify surface (via callbackQueryHandler)
    //   approve:*     → approval handler
    //   deny:*        → approval handler
    //   (other)       → clarify surface (backward compat)
    this.bot.on('callback_query:data', (ctx) => {
      const cq = ctx.callbackQuery;
      const messageId = cq.message?.message_id;
      const chatId = cq.message?.chat?.id;
      if (messageId === undefined || chatId === undefined) return;

      const data = cq.data;
      const event: CallbackQueryEvent = {
        queryId: cq.id,
        data,
        chatId: String(chatId),
        messageId: String(messageId),
        userId: cq.from ? String(cq.from.id) : undefined,
        username: cq.from?.username,
        answer: async (text) => {
          await ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {});
        },
      };

      // Route approval callbacks to the approval handler.
      if (data.startsWith('approve:') || data.startsWith('deny:')) {
        if (this.approvalDecisionHandler) {
          const isApprove = data.startsWith('approve:');
          const approvalId = data.slice(isApprove ? 8 : 5);
          if (approvalId) {
            const decision: 'allow' | 'deny' = isApprove ? 'allow' : 'deny';
            const decisionEvent: ApprovalDecisionEvent = {
              approvalId,
              decision,
              decidedBy: event.username ?? event.userId ?? 'unknown',
              channelId: event.chatId,
              messageTs: event.messageId,
            };
            void Promise.resolve()
              .then(() => this.approvalDecisionHandler?.(decisionEvent))
              .then(() => event.answer())
              .catch(() => event.answer());
          } else {
            void event.answer();
          }
        } else {
          void event.answer('No approval handler registered.');
        }
        return;
      }

      // Everything else → clarify surface.
      if (this.callbackQueryHandler) {
        this.callbackQueryHandler(event);
      }
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
  // Media download helper
  // ---------------------------------------------------------------------------

  /**
   * Download media descriptors and attach them to the message. Best-effort:
   * files that exceed the size cap get a text note appended; files that fail
   * to download are silently skipped. Returns the enriched message.
   */
  private async downloadAndAttach(
    msg: InboundMessage,
    media: MediaDescriptor[],
  ): Promise<InboundMessage> {
    const attachments: Attachment[] = [];
    let textSuffix = '';

    for (const m of media) {
      // Early size check from the descriptor (before getFile round-trip)
      if (m.fileSize !== undefined && m.fileSize > MAX_FILE_SIZE) {
        textSuffix += '\n(File too large — 25 MB limit)';
        continue;
      }

      const result = await downloadTelegramFile(this.bot.api, this.bot.token, m);

      if (result === null) {
        // getFile told us it's too large, or network failure
        if (m.fileSize !== undefined && m.fileSize > MAX_FILE_SIZE) {
          textSuffix += '\n(File too large — 25 MB limit)';
        }
        continue;
      }

      attachments.push({
        type: m.type,
        mimeType: m.mimeType,
        data: result.data,
        filename: m.filename,
      });
    }

    const enrichedText = textSuffix ? `${msg.text}${textSuffix}` : msg.text;
    return {
      ...msg,
      text: enrichedText,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  async send(chatId: string, message: OutboundMessage): Promise<DeliveryResult> {
    const useHtml = this.parseMode === 'html';
    const chunks = chunkText(message.text, this.maxMessageLength);
    const totalChunks = chunks.length;
    const ids: string[] = [];
    const threadOpt = message.threadId ? { message_thread_id: Number(message.threadId) } : {};

    for (let i = 0; i < chunks.length; i++) {
      const raw = chunks[i];
      const body = useHtml ? markdownToTelegramHtml(raw) : raw;
      const parseOpt = useHtml ? 'HTML' : undefined;

      try {
        const sent = await this.bot.api.sendMessage(Number(chatId), body, {
          ...(parseOpt ? { parse_mode: parseOpt } : {}),
          reply_parameters: message.replyToId
            ? { message_id: Number(message.replyToId) }
            : undefined,
          ...threadOpt,
        });
        ids.push(String(sent.message_id));
      } catch (err) {
        // HTML/Markdown parse errors — retry as plain text (observable fallback)
        if (String(err).includes('parse')) {
          console.warn(
            `[telegram] HTML parse fallback chunk=${i + 1}/${totalChunks} hash=${chunkHash(raw)}`,
          );
          const sent = await this.bot.api
            .sendMessage(Number(chatId), raw, threadOpt)
            .catch(() => null);
          if (sent) ids.push(String(sent.message_id));
        } else {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }

    // Clear receipt reaction now that the reply has landed.
    const trackedMsgId = this.pendingReactions.get(chatId);
    if (trackedMsgId !== undefined) {
      this.bot.api.setMessageReaction(Number(chatId), trackedMsgId, []).catch(() => {});
      this.pendingReactions.delete(chatId);
    }

    this.rememberChunkIds(ids);
    return { ok: true, messageId: ids[0] };
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.bot.api.sendChatAction(Number(chatId), 'typing').catch(() => {});
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<DeliveryResult> {
    const useHtml = this.parseMode === 'html';
    try {
      const newChunks = chunkText(text, this.maxMessageLength);
      const existingIds = this.chunkMap.get(messageId) ?? [messageId];

      const updatedIds = await reflowChunks(newChunks, existingIds, {
        edit: async (id, chunk) => {
          const body = useHtml ? markdownToTelegramHtml(chunk) : chunk;
          await this.bot.api.editMessageText(Number(chatId), Number(id), body, {
            ...(useHtml ? { parse_mode: 'HTML' as const } : {}),
          });
          return id;
        },
        append: async (chunk) => {
          const body = useHtml ? markdownToTelegramHtml(chunk) : chunk;
          const sent = await this.bot.api.sendMessage(Number(chatId), body, {
            ...(useHtml ? { parse_mode: 'HTML' as const } : {}),
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

  // ---------------------------------------------------------------------------
  // Tool-approval cards (ApprovalCapableAdapter)
  //
  // Mirrors the Slack adapter's approval surface. The gateway's approval
  // coordinator drives these methods: post a card when a dangerous tool call
  // is gated, update it in place once the user decides. The adapter never
  // imports the gateway — the coordinator hands it a plain chatId/threadId.
  // ---------------------------------------------------------------------------

  /** Post the pending approval card with Approve/Deny inline buttons.
   *  Returns the message id (as `messageTs` for interface compat with Slack). */
  async postApprovalCard(input: {
    chatId: string;
    threadId?: string;
    approvalId: string;
    toolName: string;
    reason: string | null;
    args: unknown;
  }): Promise<{ messageTs: string } | { error: string }> {
    const reasonLine = input.reason ? `\nReason: ${input.reason}` : '';
    const argsLine = input.args ? `\nArgs: ${JSON.stringify(input.args)}` : '';
    const text = `Tool approval required: ${input.toolName}${reasonLine}${argsLine}`;

    const rows: InlineButton[][] = [
      [
        { label: '✅ Approve', data: `approve:${input.approvalId}` },
        { label: '❌ Deny', data: `deny:${input.approvalId}` },
      ],
    ];
    const threadOpt = input.threadId ? { message_thread_id: Number(input.threadId) } : {};

    try {
      const kb = new InlineKeyboard();
      for (const btn of rows[0]) kb.text(btn.label, btn.data);
      const sent = await this.bot.api.sendMessage(Number(input.chatId), text, {
        reply_markup: kb,
        ...threadOpt,
      });
      return { messageTs: String(sent.message_id) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Replace a posted approval card with its resolved state — removes the
   *  buttons so the card can't be clicked twice. */
  async updateApprovalCard(input: {
    chatId: string;
    messageTs: string;
    toolName: string;
    decision: 'allow' | 'deny';
    decidedBy: string;
  }): Promise<DeliveryResult> {
    const verb = input.decision === 'allow' ? 'Approved' : 'Denied';
    const text = `Tool: ${input.toolName} — ${verb} by @${input.decidedBy}`;
    return this.editToPlainText(input.chatId, input.messageTs, text);
  }

  /** Register the approval-card button-click handler. The coordinator wires
   *  this to its approve() / deny() calls. */
  onApprovalDecision(handler: (event: ApprovalDecisionEvent) => void): void {
    this.approvalDecisionHandler = handler;
  }
}
