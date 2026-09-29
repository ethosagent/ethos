import { join } from 'node:path';
import { ChannelOverrideStore, type ChannelPresenceResolver } from '@ethosagent/core';
import type {
  AdapterCapabilities,
  AdapterVoiceCaps,
  ApprovalCapableAdapter,
  ApprovalDecisionEvent,
  AttachmentCache,
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
  SendVoiceNoteOptions,
  Storage,
  VoiceOutboundAdapter,
} from '@ethosagent/types';
import type { Client, Interaction } from 'discord.js';
import { chunkText, reflowChunks } from './chunking';
import type { clarifyModalPayload } from './clarify-blocks';
import type { CommandContext, CommandPayload } from './commands';
import { COMMAND_DEFINITIONS, dispatch } from './commands';
import type { Binding, ChannelMode } from './config';
import { ChannelModeSchema, DEFAULT_CHANNEL_MODE } from './config';
import { buildModal, registerInteractionHandler, toActionRowBuilder } from './events/interactions';
import { registerEditHandler, registerMessageHandler } from './events/messages';
import { toNativeMarkdown } from './format';
import { discord } from './sdk';
import { BackfillStateStore } from './store/backfill-state';
import { ThreadStateStore } from './store/thread-state';
import type { DiscordClarifyInteraction } from './types';

export { chunkText, reflowChunks } from './chunking';
export type { DiscordClarifyInteraction } from './types';
export type { DiscordAdapterConfig };

interface DiscordAdapterConfig {
  token: string;
  /** @deprecated Use `defaultChannelMode` instead. */
  mentionOnly?: boolean;
  /** Stable bot identity, computed once in wiring (`deriveBotKey`). Required —
   *  the adapter no longer derives its own key, so routing (lane keys,
   *  `InboundMessage.botKey`) is stamped from this single source of truth. */
  botKey: string;
  /** Receipt reaction on inbound messages, cleared when the reply lands. When
   *  set it wins over the bound personality's `display.emoji`; absent = that
   *  emoji, else '👀'. `''` = no receipt reaction. */
  receiptReaction?: string;
  /**
   * Count a guild message that names the bound personality (a whole word,
   * case-insensitive — `mentionsPersonalityName` in `@ethosagent/core`) as a
   * mention. Opt-in; default `false`. The name comes from the presence
   * resolver the gateway binds (`setPresenceResolver`).
   */
  mentionByName?: boolean;
  cache?: AttachmentCache;
  storage?: Storage;
  discordDir?: string;
  binding?: Binding;
  defaultChannelMode?: ChannelMode;
  applicationId?: string;
  /**
   * Where to register slash commands. Omit or set to `undefined` to skip
   * registration entirely (production default — register via a separate
   * provisioning step). Set to a guild ID string for instant dev iteration.
   * Set to `'global'` only when you explicitly want to overwrite the
   * application's entire global command set on every startup.
   */
  registerCommandsTo?: 'global' | string;
  /**
   * Discord role IDs permitted to approve/deny tool executions.
   * Required when approvalPolicy is 'role_gate' (the default).
   */
  approvalRoleIds?: string[];
  /**
   * Who may click approval buttons.
   * - `'role_gate'` (default): only users with a role in `approvalRoleIds`
   *   may resolve. If `approvalRoleIds` is empty/unset, all clicks are rejected.
   * - `'allow_any'`: any channel member may approve (explicit opt-in to open).
   */
  approvalPolicy?: 'role_gate' | 'allow_any';
  /**
   * CHS-005 — sink for security decisions this adapter makes alone. An
   * approval-button refusal never reaches the gateway, so without this it is
   * visible only as an ephemeral reply to the person who was refused.
   *
   * Declared structurally so the adapter takes no dependency on the
   * observability implementation; the gateway supplies it.
   */
  observability?: {
    recordSafetyBlock(opts: {
      code?: string;
      cause?: string;
      details?: Record<string, unknown>;
    }): void;
  };
  /**
   * When enabled, `sendTyping()` posts a short "Thinking..." placeholder
   * message that is deleted when the real response is sent. Default: true
   * (H1 / UD4, ux-feedback-and-config-clarity) — set `false` explicitly to
   * suppress it.
   */
  postThinkingPlaceholder?: boolean;
  /**
   * Override for the largest inbound attachment this adapter will download
   * (bytes). Absent = the adapter's own 25 MB default. Set from
   * `gateway.maxInboundMediaBytes`.
   */
  maxInboundMediaBytes?: number;
  /**
   * Missed-message backfill: the slice of channel history read the first time
   * this bot sees a lane, so its first reply is not context-blind. Absent =
   * today's behaviour (on, 50 messages, no age bound). Set from
   * `discord.missedMessageBackfill`.
   */
  missedMessageBackfill?: { enabled?: boolean; windowSeconds?: number; limit?: number };
}

/**
 * Discord JSON error codes no retry can fix: Unknown Channel, Missing Access,
 * Cannot send messages to this user, Missing Permissions.
 */
const PERMANENT_DISCORD_CODES = new Set([10003, 50001, 50007, 50013]);

/**
 * A tracked "Thinking…" placeholder whose typing refresh last fired this long
 * ago belongs to a PREVIOUS turn that ended without a reply (errored, halted,
 * or answered elsewhere). The adapter has no turn id — `sendTyping(chatId, opts)`
 * is the whole contract — so the turn boundary is inferred: the gateway refreshes
 * typing every few seconds while a turn is live, and a gap this large means
 * the turn is over. The next `sendTyping` then deletes the stale message and
 * posts a fresh one, so a placeholder is posted per TURN, never once per chat
 * lifetime. The normal boundary is still `send()`/`editMessage()`, which
 * delete the placeholder outright (`clearThinkingPlaceholder`).
 */
const THINKING_PLACEHOLDER_STALE_MS = 30_000;

/**
 * Does `err` (a discord.js `DiscordAPIError`, read by shape) say the bot can
 * never post here — until an operator changes something? HTTP 403/404 or one
 * of {@link PERMANENT_DISCORD_CODES}. Rate limits (429) and server errors are
 * not: discord.js retries 429s itself and a 5xx is transient.
 */
function isPermanentDiscordError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = 'status' in err ? err.status : undefined;
  const code = 'code' in err ? err.code : undefined;
  if (status === 403 || status === 404) return true;
  return typeof code === 'number' && PERMANENT_DISCORD_CODES.has(code);
}

/**
 * discord.js error codes `client.login()` raises when the credentials or the
 * application settings are wrong — a revoked or mistyped token, or a
 * privileged intent the Developer Portal has not enabled. No retry fixes
 * either; an operator has to.
 */
const PERMANENT_DISCORD_LOGIN_CODES = new Set([
  'TokenInvalid',
  'TokenMissing',
  'DisallowedIntents',
]);

/**
 * `err` re-thrown carrying `permanent: true` when it is a login failure no
 * retry can fix (a {@link PERMANENT_DISCORD_LOGIN_CODES} code, or an HTTP 401),
 * so the gateway's adapter-start retry (`isPermanentAdapterStartError`,
 * apps/ethos/src/commands/gateway.ts) gives up instead of retrying a dead
 * token for ever. Anything else is returned unchanged.
 */
function classifyDiscordStartError(err: unknown): unknown {
  if (typeof err !== 'object' || err === null) return err;
  const code = 'code' in err ? err.code : undefined;
  const status = 'status' in err ? err.status : undefined;
  const permanent =
    (typeof code === 'string' && PERMANENT_DISCORD_LOGIN_CODES.has(code)) || status === 401;
  if (!permanent) return err;
  const detail = err instanceof Error ? err.message : String(code ?? status);
  return Object.assign(new Error(`Discord refused the bot login: ${detail}`, { cause: err }), {
    permanent: true,
  });
}

export class DiscordAdapter
  implements PlatformAdapter, ApprovalCapableAdapter, VoiceOutboundAdapter
{
  readonly id: string;
  readonly displayName = 'Discord';
  readonly canSendTyping = true;
  readonly canEditMessage = true;
  readonly canReact = true;
  /**
   * Stays `false` even though {@link sendVoiceNote} can attach a file. The
   * gateway derives generic outbound-media caps from this flag (see
   * `outboundMediaCaps` in `@ethosagent/gateway`), and `send()` still ignores
   * `OutboundMessage.attachments` — flipping it would make the gateway build
   * attachments that Discord then silently drops. It flips when `send()`
   * learns to upload attachments, not before.
   */
  readonly canSendFiles = false;
  readonly maxMessageLength = 2000;

  /**
   * Declared voice capabilities. Discord has no voice-bubble primitive for
   * bot messages — an uploaded audio file gets an inline player — so the
   * honest declaration is `kind: 'file'`.
   */
  readonly voiceCaps: AdapterVoiceCaps = {
    inbound: ['ogg', 'mp3', 'm4a', 'wav'],
    outbound: {
      formats: ['mp3', 'ogg', 'wav'],
      kind: 'file',
      maxBytes: 25 * 1024 * 1024,
    },
  };

  get capabilities(): AdapterCapabilities {
    return {
      platform: 'discord',
      typing: true,
      editDetection: true,
      replyToThreading: true,
      persistence: true,
      channelModes: true,
      homeView: true,
      joinGreeting: false,
      roleBasedApprovals: true,
      // Kept in sync with `canSendFiles` — see the note there.
      outboundFiles: false,
      webhookMode: false,
    };
  }

  readonly botKey: string;

  private readonly client: Client;
  private readonly token: string;
  private readonly receiptReaction: string;
  /** `receiptReaction` was configured: it wins over the personality emoji. */
  private readonly receiptReactionExplicit: boolean;
  private readonly mentionByName: boolean;
  private readonly cache?: AttachmentCache;
  private readonly applicationId?: string;
  private readonly registerCommandsTo?: 'global' | string;
  private readonly binding: Binding;
  private readonly defaultChannelMode: ChannelMode;
  private readonly approvalRoleIds: string[];
  /** CHS-005 — optional sink for adapter-local security decisions. */
  private readonly observability: DiscordAdapterConfig['observability'];
  private readonly approvalPolicy: 'role_gate' | 'allow_any';
  /**
   * UD4 — true when `sendTyping` posts the "Thinking…" placeholder. Read
   * structurally by the gateway (`placeholderCoversLane` in
   * `extensions/gateway/src/index.ts`) to skip the H1 `_working on it…_`
   * notice on lanes the placeholder already covers — a plain optional
   * property, not a PlatformAdapter contract field.
   */
  readonly postsThinkingPlaceholder: boolean;
  /** Inbound-attachment ceiling override, bytes. Absent = the 25 MB default. */
  private readonly maxInboundMediaBytes: number | undefined;
  private readonly missedMessageBackfill: DiscordAdapterConfig['missedMessageBackfill'];

  private readonly threadState?: ThreadStateStore;
  private readonly channelOverrides?: ChannelOverrideStore<ChannelMode>;
  private readonly backfillState?: BackfillStateStore;

  private messageHandler?: (message: InboundMessage) => void;
  private clarifyInteractionHandler?: (raw: DiscordClarifyInteraction) => void;
  private approvalDecisionHandler?: (event: ApprovalDecisionEvent) => void;
  private commandContext?: CommandContext;

  private readonly pendingInteractions = new Map<string, Interaction>();
  /**
   * V2-RT-1 — `start()` is re-entrant: the gateway's adapter-start retry
   * (`retryAdapterStart`, apps/ethos/src/commands/gateway.ts) calls it again on
   * this same instance after a transient login failure, and discord.js runs
   * every listener registered for an event. The handlers are therefore
   * registered once per instance; only the loads, the slash-command upload and
   * the login are repeated. Pinned by `__tests__/start-permanent-error.test.ts`
   * ('registers each event handler once across a retried start').
   */
  private handlersRegistered = false;
  private extraCommands: { name: string; description: string }[] = [];
  private readonly chunkMap = new Map<string, string[]>();
  private readonly chunkMapMaxEntries = 1024;
  /** Receipt reactions pending clearing, keyed by inbound messageId → channelId. Bounded FIFO. */
  /** messageId → its channel and every receipt emoji that may have landed. */
  private readonly pendingReactions = new Map<string, { channelId: string; reactions: string[] }>();
  /** Who this bot speaks as per chat — bound by the gateway
   *  (`Gateway.bindPresence`). */
  private presence?: ChannelPresenceResolver;
  private readonly pendingReactionsMax = 256;
  /** The current turn's thinking placeholder per target channel (the thread
   *  for a thread turn, else the chat): its messageId plus when
   *  the typing refresh last touched it (per-turn staleness — see
   *  {@link THINKING_PLACEHOLDER_STALE_MS}). */
  private readonly thinkingMessages = new Map<
    string,
    { messageId: string; lastTypingAt: number }
  >();

  constructor(config: DiscordAdapterConfig) {
    this.token = config.token;
    this.receiptReaction = config.receiptReaction ?? '👀';
    this.receiptReactionExplicit = config.receiptReaction !== undefined;
    this.mentionByName = config.mentionByName ?? false;
    this.botKey = config.botKey;
    this.id = `discord:${this.botKey}`;
    this.cache = config.cache;
    this.applicationId = config.applicationId;
    this.registerCommandsTo = config.registerCommandsTo;
    this.binding = config.binding ?? { type: 'personality', name: 'default' };
    this.approvalRoleIds = config.approvalRoleIds ?? [];
    this.approvalPolicy = config.approvalPolicy ?? 'role_gate';
    this.observability = config.observability;
    this.postsThinkingPlaceholder = config.postThinkingPlaceholder ?? true;
    this.maxInboundMediaBytes = config.maxInboundMediaBytes;
    this.missedMessageBackfill = config.missedMessageBackfill;

    // Gap 9: derive defaultChannelMode from deprecated mentionOnly when
    // the caller hasn't set defaultChannelMode explicitly.
    if (config.defaultChannelMode !== undefined) {
      this.defaultChannelMode = config.defaultChannelMode;
    } else if (config.mentionOnly !== undefined) {
      this.defaultChannelMode = config.mentionOnly ? 'mention_only' : 'all';
    } else {
      this.defaultChannelMode = DEFAULT_CHANNEL_MODE;
    }

    if (config.storage) {
      const dir = config.discordDir ?? 'discord';
      this.threadState = new ThreadStateStore(config.storage, dir, this.botKey);
      // The shared store (`@ethosagent/core`) takes the PER-BOT directory and
      // the adapter's own mode enum; Discord's deleted copy took the platform
      // dir plus a botKey and joined them itself.
      this.channelOverrides = new ChannelOverrideStore(
        config.storage,
        join(dir, this.botKey),
        ChannelModeSchema,
      );
      this.backfillState = new BackfillStateStore(config.storage, dir, this.botKey);
    }

    const { Client, GatewayIntentBits, Partials } = discord();
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
      // V-GC-3 — no ping by default, on every send and edit; the explicit
      // `allowedMentions: { parse: [] }` at each call site stays as well.
      // `toNativeMarkdown` keeps `<@id>` / `<@&role>` text (UBP-013), so this
      // is the only thing between a model's reply and a mass mention. Pinned
      // by `__tests__/thread-typing.test.ts` ('never lets a reply ping').
      allowedMentions: { parse: [] },
    });
  }

  /** Gateway hook (`Gateway.bindPresence`): who this bot speaks as per chat.
   *  Read by the receipt reaction and by `mentionByName` at event time. */
  setPresenceResolver(resolve: ChannelPresenceResolver): void {
    this.presence = resolve;
  }

  async start(): Promise<void> {
    await this.threadState?.load();
    await this.channelOverrides?.load();
    await this.backfillState?.load();

    const messageCtx = {
      client: this.client,
      botKey: this.botKey,
      defaultChannelMode: this.defaultChannelMode,
      receiptReaction: this.receiptReaction,
      receiptReactionExplicit: this.receiptReactionExplicit,
      cache: this.cache,
      channelOverrides: this.channelOverrides,
      threadState: this.threadState,
      backfillState: this.backfillState,
      maxInboundMediaBytes: this.maxInboundMediaBytes,
      backfill: this.missedMessageBackfill,
      onMessage: (msg: InboundMessage) => this.messageHandler?.(msg),
      presence: (chatId: string, threadId?: string) => this.presence?.(chatId, threadId),
      mentionByName: this.mentionByName,
      onReceipt: (channelId: string, messageId: string, reactions: string[]) => {
        if (this.pendingReactions.size >= this.pendingReactionsMax) {
          const oldest = this.pendingReactions.keys().next().value;
          if (oldest !== undefined) this.pendingReactions.delete(oldest);
        }
        this.pendingReactions.set(messageId, { channelId, reactions });
      },
    };

    if (!this.handlersRegistered) {
      this.handlersRegistered = true;
      registerMessageHandler(messageCtx);
      registerEditHandler(messageCtx);

      registerInteractionHandler(this.client, {
        pendingInteractions: this.pendingInteractions,
        onClarifyInteraction: (raw) => this.clarifyInteractionHandler?.(raw),
        onCommand: (payload, interaction) => this.handleCommand(payload, interaction),
        onApprovalDecision: (approvalId, decision, userId, interaction) => {
          this.handleApprovalDecision(approvalId, decision, userId, interaction);
        },
      });
    }

    if (this.applicationId && this.registerCommandsTo) {
      await this.registerSlashCommands();
    }

    try {
      await this.client.login(this.token);
    } catch (err) {
      throw classifyDiscordStartError(err);
    }
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  /**
   * Once ANY chunk has reached the channel this reports `ok: true`: the
   * gateway's delivery sweep redelivers a whole `ok: false` reply, so a
   * failure after the first chunk would re-post the text that did land on
   * every retry. The residual is a truncated reply — the chunks after the
   * failure are lost, named in `error` as `partial: N of M chunks` — which is
   * the smaller failure than a repeated one. Bookkeeping after the last chunk
   * (receipt reaction, thread state) cannot turn a delivery into a failure
   * either. A refusal no retry can fix is marked `permanent`
   * (`isPermanentDiscordError`). Pinned by `__tests__/send-delivery.test.ts`.
   */
  async send(chatId: string, message: OutboundMessage): Promise<DeliveryResult> {
    const ids: string[] = [];
    let total = 0;
    try {
      const targetId = message.threadId ?? chatId;
      await this.clearThinkingPlaceholder(targetId);

      const channel = await this.client.channels.fetch(targetId);
      if (!channel || !('send' in channel)) {
        return { ok: false, error: 'Channel not found or not sendable', permanent: true };
      }

      const chunks = chunkText(toNativeMarkdown(message.text), this.maxMessageLength);
      total = chunks.length;

      for (const chunk of chunks) {
        // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
        const sent = await (channel as any).send({
          content: chunk,
          allowedMentions: { parse: [] },
        });
        ids.push(String(sent.id));
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (ids.length > 0) {
        this.rememberChunkIds(ids);
        return {
          ok: true,
          messageId: ids[0],
          error: `partial: ${ids.length} of ${total} chunks delivered; ${error}`,
        };
      }
      return isPermanentDiscordError(err)
        ? { ok: false, error, permanent: true }
        : { ok: false, error };
    }

    this.rememberChunkIds(ids);
    try {
      await this.clearReceiptReaction(chatId);
      if (message.threadId && this.threadState) {
        await this.threadState.recordPost(chatId, message.threadId);
      }
    } catch {
      // Best-effort: the reply is already in the channel.
    }
    return { ok: true, messageId: ids[0] };
  }

  /**
   * The declared voice sink — attaches the synthesized audio, which Discord
   * renders with an inline player. Threads are addressed the same way `send()`
   * addresses them: by replacing the target channel with the thread's id.
   * Never throws: `{ok:true}` is the delivery ledger's only proof of delivery.
   */
  async sendVoiceNote(
    chatId: string,
    audio: Uint8Array,
    opts: SendVoiceNoteOptions,
  ): Promise<DeliveryResult> {
    try {
      const targetId = opts.threadId ?? chatId;
      const channel = await this.client.channels.fetch(targetId);
      if (!channel || !('send' in channel)) {
        return { ok: false, error: 'Channel not found or not sendable' };
      }

      const { AttachmentBuilder } = discord();
      // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
      const sent = await (channel as any).send({
        files: [new AttachmentBuilder(Buffer.from(audio), { name: opts.filename })],
        ...(opts.caption ? { content: opts.caption } : {}),
        allowedMentions: { parse: [] },
      });

      if (opts.threadId && this.threadState) {
        await this.threadState.recordPost(chatId, opts.threadId);
      }

      return { ok: true, messageId: String(sent.id) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Typing and the "Thinking…" placeholder go to `opts.threadId` when the turn
   * is in a thread — the gateway's `chatId` is the PARENT channel there — and
   * the placeholder is tracked per target channel, so two threads under one
   * parent each keep their own (UBP-017, pinned by
   * `__tests__/thread-typing.test.ts`).
   */
  async sendTyping(chatId: string, opts?: { threadId?: string }): Promise<void> {
    const targetId = opts?.threadId ?? chatId;
    try {
      const channel = await this.client.channels.fetch(targetId);
      if (channel && 'sendTyping' in channel) {
        // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
        await (channel as any).sendTyping();
      }
      if (this.postsThinkingPlaceholder && channel && 'send' in channel) {
        const existing = this.thinkingMessages.get(targetId);
        if (existing && Date.now() - existing.lastTypingAt <= THINKING_PLACEHOLDER_STALE_MS) {
          // Same turn — the gateway's periodic typing refresh. Keep the one
          // placeholder and slide the liveness window.
          existing.lastTypingAt = Date.now();
          return;
        }
        if (existing) {
          // A previous turn's placeholder no send() ever cleared (the turn
          // ended without a reply). Delete it so the channel never accumulates
          // stale "Thinking…" rows, then post this turn's own.
          await this.clearThinkingPlaceholder(targetId);
        }
        // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
        const placeholder = await (channel as any).send({
          content: 'Thinking…',
          allowedMentions: { parse: [] },
        });
        this.thinkingMessages.set(targetId, {
          messageId: String(placeholder.id),
          lastTypingAt: Date.now(),
        });
      }
    } catch {
      // ignore
    }
  }

  /** A thread's messages live in the thread channel, so `opts.threadId` is
   *  where the edit fetches from (UBP-017). */
  async editMessage(
    chatId: string,
    messageId: string,
    text: string,
    opts?: { final?: boolean; threadId?: string },
  ): Promise<DeliveryResult> {
    const targetId = opts?.threadId ?? chatId;
    try {
      await this.clearThinkingPlaceholder(targetId);

      const channel = await this.client.channels.fetch(targetId);
      if (!channel || !('messages' in channel) || !('send' in channel)) {
        return { ok: false, error: 'Channel not found' };
      }

      const newChunks = chunkText(toNativeMarkdown(text), this.maxMessageLength);
      const existingIds = this.chunkMap.get(messageId) ?? [messageId];

      const updatedIds = await reflowChunks(newChunks, existingIds, {
        edit: async (id, chunk) => {
          // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
          const msg = await (channel as any).messages.fetch(id);
          const edited = await msg.edit({ content: chunk, allowedMentions: { parse: [] } });
          return String(edited.id);
        },
        append: async (chunk) => {
          // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
          const sent = await (channel as any).send({
            content: chunk,
            allowedMentions: { parse: [] },
          });
          return String(sent.id);
        },
        deleteId: async (id) => {
          // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
          const msg = await (channel as any).messages.fetch(id);
          await msg.delete();
        },
      });

      this.chunkMap.delete(messageId);
      this.rememberChunkIds(updatedIds);
      return { ok: true, messageId: updatedIds[0] };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async health(): Promise<{ ok: boolean; latencyMs?: number }> {
    return {
      ok: this.client.ws.status === 0,
      latencyMs: this.client.ws.ping,
    };
  }

  // ---------------------------------------------------------------------------
  // Clarify
  // ---------------------------------------------------------------------------

  async postClarifyCard(input: {
    chatId: string;
    content: string;
    components: unknown[];
  }): Promise<{ messageId: string } | { error: string }> {
    try {
      const channel = await this.client.channels.fetch(input.chatId);
      if (!channel || !('send' in channel)) return { error: 'Channel not found or not sendable' };
      // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
      const sent = await (channel as any).send({
        content: input.content,
        components: input.components.map(toActionRowBuilder),
        allowedMentions: { parse: [] },
      });
      return { messageId: String(sent.id) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  async updateClarifyCard(input: {
    chatId: string;
    messageId: string;
    content: string;
    components: unknown[];
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const channel = await this.client.channels.fetch(input.chatId);
      if (!channel || !('messages' in channel)) return { ok: false, error: 'Channel not found' };
      // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
      const msg = await (channel as any).messages.fetch(input.messageId);
      await msg.edit({
        content: input.content,
        components: input.components.map(toActionRowBuilder),
        allowedMentions: { parse: [] },
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async openClarifyModal(input: {
    interactionId: string;
    interactionToken: string;
    modal: ReturnType<typeof clarifyModalPayload>;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    void input.interactionToken;
    const pending = this.pendingInteractions.get(input.interactionId);
    if (!pending?.isButton()) {
      return { ok: false, error: 'No pending button interaction for this id' };
    }
    this.pendingInteractions.delete(input.interactionId);
    try {
      await pending.showModal(buildModal(input.modal));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async ackButtonClick(input: { interactionId: string; interactionToken: string }): Promise<void> {
    void input.interactionToken;
    const pending = this.pendingInteractions.get(input.interactionId);
    if (!pending?.isButton()) return;
    this.pendingInteractions.delete(input.interactionId);
    try {
      await pending.deferUpdate();
    } catch {
      // Best-effort
    }
  }

  async ackModalSubmit(input: { interactionId: string; interactionToken: string }): Promise<void> {
    void input.interactionToken;
    const pending = this.pendingInteractions.get(input.interactionId);
    if (!pending?.isModalSubmit()) return;
    this.pendingInteractions.delete(input.interactionId);
    try {
      await pending.deferUpdate();
    } catch {
      // Best-effort
    }
  }

  onClarifyInteraction(handler: (raw: DiscordClarifyInteraction) => void): void {
    this.clarifyInteractionHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // Approval (Move 7)
  // ---------------------------------------------------------------------------

  async postApprovalCard(input: {
    chatId: string;
    threadId?: string;
    approvalId: string;
    toolName: string;
    reason: string | null;
    args: unknown;
  }): Promise<{ messageTs: string } | { error: string }> {
    try {
      const targetId = input.threadId ?? input.chatId;
      const channel = await this.client.channels.fetch(targetId);
      if (!channel || !('send' in channel)) return { error: 'Channel not found' };
      const { approvalPendingEmbed, approvalPendingButtons } = await import('./blocks/approval');
      const emb = approvalPendingEmbed({
        approvalId: input.approvalId,
        toolName: input.toolName,
        reason: input.reason,
        args: input.args,
      });
      const buttons = approvalPendingButtons(input.approvalId);
      // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
      const sent = await (channel as any).send({
        embeds: [emb],
        components: [toActionRowBuilder(buttons)],
      });
      return { messageTs: String(sent.id) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  async updateApprovalCard(input: {
    chatId: string;
    messageTs: string;
    toolName: string;
    decision: 'allow' | 'deny';
    decidedBy: string;
  }): Promise<DeliveryResult> {
    try {
      const { approvalResolvedEmbed } = await import('./blocks/approval');
      const emb = approvalResolvedEmbed({
        toolName: input.toolName,
        decision: input.decision,
        decidedBy: input.decidedBy,
      });
      // The message lives in whatever channel/thread postApprovalCard sent it to.
      // The gateway passes the interaction's channelId as chatId — for threaded
      // approvals this is the thread channel, matching where the card was posted.
      const channel = await this.client.channels.fetch(input.chatId);
      if (!channel || !('messages' in channel)) return { ok: false, error: 'Channel not found' };
      // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
      const msg = await (channel as any).messages.fetch(input.messageTs);
      await msg.edit({ embeds: [emb], components: [] });
      return { ok: true, messageId: input.messageTs };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  onApprovalDecision(handler: (event: ApprovalDecisionEvent) => void): void {
    this.approvalDecisionHandler = handler;
  }

  setCommandContext(ctx: CommandContext): void {
    this.commandContext = ctx;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async handleCommand(payload: CommandPayload, interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;
    try {
      await interaction.deferReply({ ephemeral: true });
      const ctx: CommandContext = this.commandContext ?? {
        binding: this.binding,
        defaultChannelMode: this.defaultChannelMode,
        channelOverrides: this.channelOverrides,
      };
      const response = await dispatch(payload, ctx);
      await interaction.editReply({
        content: response.content,
        // biome-ignore lint/suspicious/noExplicitAny: embed shape matches Discord API
        embeds: response.embeds as any[],
      });
    } catch {
      try {
        if (interaction.deferred) {
          await interaction.editReply({ content: 'An error occurred processing this command.' });
        }
      } catch {
        // Best-effort
      }
    }
  }

  private handleApprovalDecision(
    approvalId: string,
    decision: 'allow' | 'deny',
    userId: string,
    interaction: Interaction,
  ): void {
    if (!interaction.isButton()) return;

    // Authorization: default-deny unless the user passes the configured policy.
    if (this.approvalPolicy === 'role_gate') {
      if (this.approvalRoleIds.length === 0) {
        // No roles configured → no one can approve. This is intentional:
        // the operator must explicitly configure approvalRoleIds or opt into 'allow_any'.
        // CHS-005 — recorded because a misconfiguration that silently blocks
        // every approval looks identical to "nobody clicked" from outside.
        this.observability?.recordSafetyBlock({
          code: 'discord.approval.role_denied',
          cause: 'approvalRoleIds is empty under role_gate',
          details: { approvalId, userId, channelId: interaction.channelId ?? '' },
        });
        interaction
          .reply({ content: 'Approval roles not configured. No one can approve.', ephemeral: true })
          .catch(() => {});
        return;
      }
      const member = interaction.member;
      const memberRoles =
        member && 'cache' in (member.roles as object)
          ? (member.roles as { cache: Map<string, unknown> }).cache
          : null;
      const hasRole = memberRoles ? this.approvalRoleIds.some((id) => memberRoles.has(id)) : false;
      if (!hasRole) {
        // CHS-005 — a refused approval click is a security decision, and the
        // ephemeral reply is seen only by the person refused.
        this.observability?.recordSafetyBlock({
          code: 'discord.approval.role_denied',
          cause: 'user holds none of the approval roles',
          details: { approvalId, userId, channelId: interaction.channelId ?? '' },
        });
        interaction
          .reply({ content: 'You do not have permission to approve/deny.', ephemeral: true })
          .catch(() => {});
        return;
      }
    }

    interaction.deferUpdate().catch(() => {});
    this.approvalDecisionHandler?.({
      approvalId,
      decision,
      decidedBy: userId,
      channelId: interaction.channelId ?? '',
      messageTs: interaction.message.id,
    });
  }

  private async registerSlashCommands(): Promise<void> {
    try {
      const { REST, Routes } = discord();
      const rest = new REST({ version: '10' }).setToken(this.token);
      const appId = this.applicationId;
      const target = this.registerCommandsTo;
      if (!appId || !target) return;
      // Guild-scoped registration is instant and safe for iteration.
      // Global registration overwrites the entire application command set —
      // only use when this adapter owns the full command surface.
      const route =
        target === 'global'
          ? Routes.applicationCommands(appId)
          : Routes.applicationGuildCommands(appId, target);
      const base = COMMAND_DEFINITIONS[0];
      const extra = this.extraCommands.map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        type: 1 as const,
      }));
      const body = [{ ...base, options: [...base.options, ...extra] }];
      await rest.put(route, { body });
    } catch {
      // Non-fatal — commands won't appear but the bot still works.
    }
  }

  /** `channelId` is the channel the placeholder was posted in — the thread's
   *  own id for a thread turn. */
  private async clearThinkingPlaceholder(channelId: string): Promise<void> {
    const entry = this.thinkingMessages.get(channelId);
    if (!entry) return;
    this.thinkingMessages.delete(channelId);
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'messages' in channel) {
        // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
        const msg = await (channel as any).messages.fetch(entry.messageId);
        await msg.delete();
      }
    } catch {
      // Best-effort cleanup
    }
  }

  private async clearReceiptReaction(chatId: string): Promise<void> {
    // Find all pending reactions belonging to this channel and clear them.
    const toClear: Array<{ msgId: string; reactions: string[] }> = [];
    for (const [msgId, pending] of this.pendingReactions) {
      if (pending.channelId === chatId) toClear.push({ msgId, reactions: pending.reactions });
    }
    if (toClear.length === 0) return;
    for (const { msgId } of toClear) this.pendingReactions.delete(msgId);
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (channel && 'messages' in channel) {
        for (const { msgId, reactions } of toClear) {
          // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
          const msg = await (channel as any).messages.fetch(msgId);
          if (this.client.user) {
            for (const emoji of reactions) {
              await msg.reactions.cache.get(emoji)?.users.remove(this.client.user.id);
            }
          }
        }
      }
    } catch {
      // Best-effort reaction removal
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

  async registerCommands(cmds: { name: string; description: string }[]): Promise<void> {
    this.extraCommands.push(...cmds);
    await this.registerSlashCommands();
  }
}

export const capabilities: AdapterCapabilities = {
  platform: 'discord',
  typing: true,
  editDetection: true,
  replyToThreading: true,
  persistence: true,
  channelModes: true,
  homeView: true,
  joinGreeting: false,
  roleBasedApprovals: true,
  // Kept in sync with `DiscordAdapter.canSendFiles` — see the note there.
  outboundFiles: false,
  webhookMode: false,
};

export { loadDiscordSdk } from './sdk';
