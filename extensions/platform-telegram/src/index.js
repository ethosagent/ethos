import { join } from 'node:path';
import { deriveBotKey } from '@ethosagent/core';
import { Bot, InlineKeyboard, webhookCallback } from 'grammy';
import { DEFAULT_CHANNEL_MODE } from './config';
import { chunkHash, markdownToTelegramHtml } from './format';
import { shouldRespond } from './routing/channel-mode';
import { ChannelOverrideStore } from './store/channel-overrides';
import { ThreadStateStore } from './store/thread-state';
// ---------------------------------------------------------------------------
// Truncation utility — BotFather fields have strict char limits
// ---------------------------------------------------------------------------
export function truncateWithEllipsis(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}
// ---------------------------------------------------------------------------
// Text chunking — Telegram has a 4096 char limit per message
// ---------------------------------------------------------------------------
export function chunkText(text, maxLength = 4096) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
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
export async function reflowChunks(newChunks, existingIds, ops) {
  const updated = [];
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
/** Map Telegram media type placeholders for captionless messages. */
const MEDIA_PLACEHOLDER = {
  image: '(attached image)',
  file: '(attached file)',
};
/**
 * Extract media descriptors from a Telegram message object.
 * Only photo (→ image) and document (→ file) produce attachments.
 * Voice, audio, video, animation, and sticker are intentionally dropped —
 * the inbound caption still reaches the agent, just no attachment is created.
 * Returns an empty array when the message has no supported media.
 */
function extractMedia(msg) {
  const results = [];
  // photo → array of PhotoSize; pick the last (highest resolution)
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    results.push({
      fileId: String(largest.file_id),
      type: 'image',
      mimeType: 'image/jpeg',
      fileSize: typeof largest.file_size === 'number' ? largest.file_size : undefined,
    });
  }
  // document
  if (msg.document && typeof msg.document === 'object') {
    const doc = msg.document;
    results.push({
      fileId: String(doc.file_id),
      type: 'file',
      mimeType: typeof doc.mime_type === 'string' ? doc.mime_type : 'application/octet-stream',
      filename: typeof doc.file_name === 'string' ? doc.file_name : undefined,
      fileSize: typeof doc.file_size === 'number' ? doc.file_size : undefined,
    });
  }
  return results;
}
/**
 * Download a single file from the Telegram Bot API. Returns a Buffer on
 * success, null on failure. Best-effort — callers handle the null case.
 */
async function downloadTelegramFile(botApi, token, descriptor) {
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
export class TelegramAdapter {
  id;
  displayName = 'Telegram';
  canSendTyping = true;
  canEditMessage = true;
  canReact = true;
  canSendFiles = false;
  maxMessageLength = 4096;
  get capabilities() {
    return {
      platform: 'telegram',
      typing: true,
      editDetection: true,
      replyToThreading: true,
      persistence: !!this.channelOverrides,
      channelModes: !!this.channelOverrides,
      webhookMode: !!this.config.useWebhook,
    };
  }
  botKey;
  bot;
  cache;
  config;
  dropPendingUpdates;
  identity;
  receiptReaction;
  parseMode;
  messageHandler;
  /** Registered by the clarify surface to receive inline-keyboard taps. */
  callbackQueryHandler;
  /** Approval-card button-click handler, wired by the approval coordinator. */
  approvalDecisionHandler;
  /** Chunk-id ledger so editMessage can re-flow multi-chunk responses. */
  chunkMap = new Map();
  chunkMapMaxEntries = 1024;
  /** Tracks inbound message ids per chat for reaction clearing on reply. */
  pendingReactions = new Map();
  editWindowMs;
  /** Anti-thrashing debounce timers for edited_message, keyed by messageId. */
  editDebounce = new Map();
  /** JSONL-backed channel mode overrides (Gap 4). */
  channelOverrides;
  /** JSONL-backed thread-follow tracking (Gap 4). */
  threadState;
  /** Webhook callback for external HTTP server wiring (Gap 6). */
  // biome-ignore lint/suspicious/noExplicitAny: grammy's webhookCallback returns an Express-typed handler
  webhookCb;
  constructor(config) {
    this.bot = new Bot(config.token);
    this.cache = config.cache;
    this.config = config;
    this.dropPendingUpdates = config.dropPendingUpdates ?? true;
    this.botKey = config.botKey ?? deriveBotKey(config.token);
    this.identity = config.identity;
    this.receiptReaction = config.receiptReaction ?? '👀';
    this.editWindowMs = config.editWindowMs ?? 60_000;
    this.parseMode = config.parseMode ?? 'html';
    // Multi-bot logs disambiguate by including the botKey. Single-bot
    // deployments pass 'default' (or omit and let the derived hash
    // stand in) and see `telegram:<key>` — the shape is identical, the
    // value carries the routing identity.
    this.id = `telegram:${this.botKey}`;
    // --- Persistence stores (Gap 4) ---
    if (config.storage) {
      const baseDir = join(config.telegramDir ?? 'telegram', this.botKey);
      this.channelOverrides = new ChannelOverrideStore(config.storage, baseDir);
      this.threadState = new ThreadStateStore(config.storage, baseDir);
    }
  }
  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  async start() {
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
    // --- Load persistence stores (Gap 4) ---
    await this.channelOverrides?.load();
    await this.threadState?.load();
    this.bot.on('message', (ctx) => {
      if (!this.messageHandler) return;
      const rawMsg = ctx.message;
      const media = extractMedia(rawMsg);
      const caption = ctx.message.text ?? ctx.message.caption ?? '';
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
      // --- Channel-mode gating (Gap 5) ---
      const isDm = ctx.chat.type === 'private';
      const isGroupMention = ctx.message.text?.includes(`@${ctx.me.username}`) ?? false;
      const chatIdStr = String(chatId);
      const override = this.channelOverrides?.get(chatIdStr);
      const channelMode = override?.mode ?? this.config.defaultChannelMode ?? DEFAULT_CHANNEL_MODE;
      const hasBotPosted =
        threadId !== undefined && this.threadState !== undefined
          ? this.threadState.hasBotPosted(chatIdStr, threadId)
          : false;
      if (
        !shouldRespond({
          isDm,
          isGroupMention,
          channelMode,
          hasBotPosted,
          messageText: text,
          regexPattern: override?.regexPattern,
        })
      ) {
        return;
      }
      // --- Reaction on receipt (best-effort, non-blocking) ---
      const reaction = [{ type: 'emoji', emoji: this.receiptReaction }];
      this.bot.api.setMessageReaction(chatId, messageId, reaction).catch(() => {});
      this.pendingReactions.set(chatIdStr, messageId);
      // --- Build initial message (attachments filled async below) ---
      const msg = {
        platform: 'telegram',
        botKey: this.botKey,
        chatId: chatIdStr,
        userId: ctx.from ? String(ctx.from.id) : undefined,
        username: ctx.from?.username,
        text,
        isDm,
        isGroupMention,
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
      const rawMsg = ctx.editedMessage;
      const caption = rawMsg.text ?? rawMsg.caption ?? '';
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
      const msg = {
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
        replyToId: rawMsg.reply_to_message ? String(rawMsg.reply_to_message.message_id) : undefined,
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
      const event = {
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
            const decision = isApprove ? 'allow' : 'deny';
            const decisionEvent = {
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
    // --- Start: webhook or long-polling (Gap 6) ---
    if (this.config.useWebhook && !this.config.webhookUrl) {
      throw new Error('TelegramAdapter: useWebhook requires webhookUrl to be set');
    }
    if (this.config.useWebhook && !this.config.webhookSecretToken) {
      throw new Error(
        'TelegramAdapter: useWebhook requires webhookSecretToken for request verification',
      );
    }
    if (this.config.useWebhook && this.config.webhookUrl) {
      await this.bot.api.setWebhook(this.config.webhookUrl, {
        secret_token: this.config.webhookSecretToken,
      });
      this.webhookCb = webhookCallback(this.bot, 'express', {
        secretToken: this.config.webhookSecretToken,
      });
    } else {
      // Non-blocking: bot.start() runs the polling loop in the background.
      // grammy's start() rejects on init failure (e.g. invalid token -> getMe 404)
      // and on terminal polling errors. Without a .catch() the rejection becomes
      // an unhandled promise rejection, which Node 24 treats as fatal — killing
      // the whole gateway and any other adapters running with it. Attach a
      // handler so a bad Telegram token degrades to a logged warning instead.
      this.bot.start({ drop_pending_updates: this.dropPendingUpdates }).catch((err) => {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[telegram] bot polling stopped: ${detail}`);
      });
    }
  }
  async stop() {
    if (this.config.useWebhook) {
      await this.bot.api.deleteWebhook().catch(() => {});
    } else {
      await this.bot.stop();
    }
  }
  /**
   * Webhook callback for external HTTP server wiring (Gap 6).
   * Returns an Express-compatible middleware when webhook mode is enabled,
   * `undefined` when polling. The host app mounts it on a route:
   * ```ts
   * app.post('/telegram/webhook', adapter.webhook);
   * ```
   */
  // biome-ignore lint/suspicious/noExplicitAny: grammy's webhookCallback returns an Express-typed handler
  get webhook() {
    return this.webhookCb;
  }
  onMessage(handler) {
    this.messageHandler = handler;
  }
  /**
   * Register a handler for inline-keyboard taps (callback queries). Used by
   * the Telegram clarify surface to receive button clicks; not part of the
   * cross-platform `PlatformAdapter` contract.
   */
  onCallbackQuery(handler) {
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
  async downloadAndAttach(msg, media) {
    const attachments = [];
    let textSuffix = '';
    const sessionKey = `telegram:${this.botKey}:${msg.chatId}`;
    for (let i = 0; i < media.length; i++) {
      const m = media[i];
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
      const filename = m.filename ?? `att-${i}.jpg`;
      const bytes = new Uint8Array(result.data);
      const url = await this.cache.write(bytes, {
        sessionKey,
        messageId: String(msg.messageId),
        filename,
        mime: m.mimeType,
      });
      attachments.push({
        type: m.type,
        ref: `att-${i}`,
        url,
        mimeType: m.mimeType,
        filename: m.filename,
        sizeBytes: result.fileSize,
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
  async send(chatId, message) {
    const useHtml = this.parseMode === 'html';
    const chunks = chunkText(message.text, this.maxMessageLength);
    const totalChunks = chunks.length;
    const ids = [];
    const threadOpt = message.threadId ? { message_thread_id: Number(message.threadId) } : {};
    for (let i = 0; i < chunks.length; i++) {
      const raw = chunks[i];
      const body = useHtml ? markdownToTelegramHtml(raw) : raw;
      const parseOpt = useHtml ? 'HTML' : undefined;
      const baseOpts = {
        ...(parseOpt ? { parse_mode: parseOpt } : {}),
        ...threadOpt,
      };
      const replyOpts = message.replyToId
        ? { ...baseOpts, reply_parameters: { message_id: Number(message.replyToId) } }
        : baseOpts;
      try {
        const sent = await this.bot.api.sendMessage(Number(chatId), body, replyOpts);
        ids.push(String(sent.message_id));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // --- Gap 8: deleted reply crash fix ---
        // If the message we're replying to was deleted, retry without reply_parameters.
        if (
          message.replyToId &&
          (errMsg.includes('message to be replied not found') ||
            errMsg.includes('replied message not found'))
        ) {
          try {
            const sent = await this.bot.api.sendMessage(Number(chatId), body, baseOpts);
            ids.push(String(sent.message_id));
          } catch (retryErr) {
            return {
              ok: false,
              error: retryErr instanceof Error ? retryErr.message : String(retryErr),
            };
          }
        } else if (errMsg.includes('parse')) {
          // HTML/Markdown parse errors — retry as plain text (observable fallback)
          console.warn(
            `[telegram] HTML parse fallback chunk=${i + 1}/${totalChunks} hash=${chunkHash(raw)}`,
          );
          const sent = await this.bot.api
            .sendMessage(Number(chatId), raw, threadOpt)
            .catch(() => null);
          if (sent) ids.push(String(sent.message_id));
        } else {
          return { ok: false, error: errMsg };
        }
      }
    }
    // Clear receipt reaction now that the reply has landed.
    const trackedMsgId = this.pendingReactions.get(chatId);
    if (trackedMsgId !== undefined) {
      this.bot.api.setMessageReaction(Number(chatId), trackedMsgId, []).catch(() => {});
      this.pendingReactions.delete(chatId);
    }
    // --- Track thread state for thread_follow mode (Gap 4) ---
    if (message.threadId && this.threadState) {
      void this.threadState.recordPost(chatId, message.threadId);
    }
    this.rememberChunkIds(ids);
    return { ok: true, messageId: ids[0] };
  }
  async sendTyping(chatId) {
    await this.bot.api.sendChatAction(Number(chatId), 'typing').catch(() => {});
  }
  async editMessage(chatId, messageId, text) {
    const useHtml = this.parseMode === 'html';
    try {
      const newChunks = chunkText(text, this.maxMessageLength);
      const existingIds = this.chunkMap.get(messageId) ?? [messageId];
      const updatedIds = await reflowChunks(newChunks, existingIds, {
        edit: async (id, chunk) => {
          const body = useHtml ? markdownToTelegramHtml(chunk) : chunk;
          await this.bot.api.editMessageText(Number(chatId), Number(id), body, {
            ...(useHtml ? { parse_mode: 'HTML' } : {}),
          });
          return id;
        },
        append: async (chunk) => {
          const body = useHtml ? markdownToTelegramHtml(chunk) : chunk;
          const sent = await this.bot.api.sendMessage(Number(chatId), body, {
            ...(useHtml ? { parse_mode: 'HTML' } : {}),
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
  rememberChunkIds(ids) {
    if (ids.length === 0) return;
    const primary = ids[0];
    while (this.chunkMap.size >= this.chunkMapMaxEntries && !this.chunkMap.has(primary)) {
      const oldestKey = this.chunkMap.keys().next().value;
      if (oldestKey === undefined) break;
      this.chunkMap.delete(oldestKey);
    }
    this.chunkMap.set(primary, ids);
  }
  async health() {
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
  async sendInlineKeyboard(chatId, text, rows) {
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
  async sendForceReply(chatId, text) {
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
  async editToPlainText(chatId, messageId, text) {
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
  async postApprovalCard(input) {
    const reasonLine = input.reason ? `\nReason: ${input.reason}` : '';
    const argsLine = input.args ? `\nArgs: ${JSON.stringify(input.args)}` : '';
    const text = `Tool approval required: ${input.toolName}${reasonLine}${argsLine}`;
    const rows = [
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
  async updateApprovalCard(input) {
    const verb = input.decision === 'allow' ? 'Approved' : 'Denied';
    const text = `Tool: ${input.toolName} — ${verb} by @${input.decidedBy}`;
    return this.editToPlainText(input.chatId, input.messageTs, text);
  }
  /** Register the approval-card button-click handler. The coordinator wires
   *  this to its approve() / deny() calls. */
  onApprovalDecision(handler) {
    this.approvalDecisionHandler = handler;
  }
}
