import { deriveBotKey } from '@ethosagent/core';
import type {
  ApprovalCapableAdapter,
  ApprovalDecisionEvent,
  AttachmentCache,
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
  Storage,
} from '@ethosagent/types';
import { Client, GatewayIntentBits, type Interaction, Partials, REST, Routes } from 'discord.js';
import { chunkText, reflowChunks } from './chunking';
import type { clarifyModalPayload } from './clarify-blocks';
import type { CommandContext, CommandPayload } from './commands';
import { COMMAND_DEFINITIONS, dispatch } from './commands';
import type { Binding, ChannelMode } from './config';
import { DEFAULT_CHANNEL_MODE } from './config';
import { buildModal, registerInteractionHandler, toActionRowBuilder } from './events/interactions';
import { registerMessageHandler } from './events/messages';
import { ChannelOverrideStore } from './store/channel-overrides';
import { ThreadStateStore } from './store/thread-state';
import type { DiscordClarifyInteraction } from './types';

export { chunkText, reflowChunks } from './chunking';
export type { DiscordClarifyInteraction } from './types';
export type { DiscordAdapterConfig };

interface DiscordAdapterConfig {
  token: string;
  mentionOnly?: boolean;
  botKey?: string;
  receiptReaction?: string;
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
}

export class DiscordAdapter implements PlatformAdapter, ApprovalCapableAdapter {
  readonly id: string;
  readonly displayName = 'Discord';
  readonly canSendTyping = true;
  readonly canEditMessage = true;
  readonly canReact = true;
  readonly canSendFiles = false;
  readonly maxMessageLength = 2000;
  readonly botKey: string;

  private readonly client: Client;
  private readonly token: string;
  private readonly mentionOnly: boolean;
  private readonly receiptReaction: string;
  private readonly cache?: AttachmentCache;
  private readonly applicationId?: string;
  private readonly registerCommandsTo?: 'global' | string;
  private readonly binding: Binding;
  private readonly defaultChannelMode: ChannelMode;
  private readonly approvalRoleIds: string[];
  private readonly approvalPolicy: 'role_gate' | 'allow_any';

  private readonly threadState?: ThreadStateStore;
  private readonly channelOverrides?: ChannelOverrideStore;

  private messageHandler?: (message: InboundMessage) => void;
  private clarifyInteractionHandler?: (raw: DiscordClarifyInteraction) => void;
  private approvalDecisionHandler?: (event: ApprovalDecisionEvent) => void;
  private commandContext?: CommandContext;

  private readonly pendingInteractions = new Map<string, Interaction>();
  private readonly chunkMap = new Map<string, string[]>();
  private readonly chunkMapMaxEntries = 1024;
  /** Receipt reactions pending clearing, keyed by inbound messageId → channelId. Bounded FIFO. */
  private readonly pendingReactions = new Map<string, string>();
  private readonly pendingReactionsMax = 256;

  constructor(config: DiscordAdapterConfig) {
    this.token = config.token;
    this.mentionOnly = config.mentionOnly ?? true;
    this.receiptReaction = config.receiptReaction ?? '👀';
    this.botKey = config.botKey ?? deriveBotKey(config.token);
    this.id = `discord:${this.botKey}`;
    this.cache = config.cache;
    this.applicationId = config.applicationId;
    this.registerCommandsTo = config.registerCommandsTo;
    this.binding = config.binding ?? { type: 'personality', name: 'default' };
    this.defaultChannelMode = config.defaultChannelMode ?? DEFAULT_CHANNEL_MODE;
    this.approvalRoleIds = config.approvalRoleIds ?? [];
    this.approvalPolicy = config.approvalPolicy ?? 'role_gate';

    if (config.storage) {
      const dir = config.discordDir ?? 'discord';
      this.threadState = new ThreadStateStore(config.storage, dir, this.botKey);
      this.channelOverrides = new ChannelOverrideStore(config.storage, dir, this.botKey);
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });
  }

  async start(): Promise<void> {
    await this.threadState?.load();
    await this.channelOverrides?.load();

    registerMessageHandler({
      client: this.client,
      botKey: this.botKey,
      mentionOnly: this.mentionOnly,
      defaultChannelMode: this.defaultChannelMode,
      receiptReaction: this.receiptReaction,
      cache: this.cache,
      channelOverrides: this.channelOverrides,
      threadState: this.threadState,
      onMessage: (msg) => this.messageHandler?.(msg),
      onReceipt: (channelId, messageId) => {
        if (this.pendingReactions.size >= this.pendingReactionsMax) {
          const oldest = this.pendingReactions.keys().next().value;
          if (oldest !== undefined) this.pendingReactions.delete(oldest);
        }
        this.pendingReactions.set(messageId, channelId);
      },
    });

    registerInteractionHandler(this.client, {
      pendingInteractions: this.pendingInteractions,
      onClarifyInteraction: (raw) => this.clarifyInteractionHandler?.(raw),
      onCommand: (payload, interaction) => this.handleCommand(payload, interaction),
      onApprovalDecision: (approvalId, decision, userId, interaction) => {
        this.handleApprovalDecision(approvalId, decision, userId, interaction);
      },
    });

    if (this.applicationId && this.registerCommandsTo) {
      await this.registerSlashCommands();
    }

    await this.client.login(this.token);
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

  async send(chatId: string, message: OutboundMessage): Promise<DeliveryResult> {
    try {
      const targetId = message.threadId ?? chatId;
      const channel = await this.client.channels.fetch(targetId);
      if (!channel || !('send' in channel)) {
        return { ok: false, error: 'Channel not found or not sendable' };
      }

      const chunks = chunkText(message.text, this.maxMessageLength);
      const ids: string[] = [];

      for (const chunk of chunks) {
        // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
        const sent = await (channel as any).send({ content: chunk });
        ids.push(String(sent.id));
      }

      this.rememberChunkIds(ids);
      await this.clearReceiptReaction(chatId);

      if (message.threadId && this.threadState) {
        await this.threadState.recordPost(chatId, message.threadId);
      }

      return { ok: true, messageId: ids[0] };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (channel && 'sendTyping' in channel) {
        // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
        await (channel as any).sendTyping();
      }
    } catch {
      // ignore
    }
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<DeliveryResult> {
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (!channel || !('messages' in channel) || !('send' in channel)) {
        return { ok: false, error: 'Channel not found' };
      }

      const newChunks = chunkText(text, this.maxMessageLength);
      const existingIds = this.chunkMap.get(messageId) ?? [messageId];

      const updatedIds = await reflowChunks(newChunks, existingIds, {
        edit: async (id, chunk) => {
          // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
          const msg = await (channel as any).messages.fetch(id);
          const edited = await msg.edit(chunk);
          return String(edited.id);
        },
        append: async (chunk) => {
          // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
          const sent = await (channel as any).send({ content: chunk });
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
      await rest.put(route, { body: COMMAND_DEFINITIONS });
    } catch {
      // Non-fatal — commands won't appear but the bot still works.
    }
  }

  private async clearReceiptReaction(chatId: string): Promise<void> {
    // Find all pending reactions belonging to this channel and clear them.
    const toClear: string[] = [];
    for (const [msgId, chId] of this.pendingReactions) {
      if (chId === chatId) toClear.push(msgId);
    }
    if (toClear.length === 0) return;
    for (const msgId of toClear) this.pendingReactions.delete(msgId);
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (channel && 'messages' in channel) {
        for (const msgId of toClear) {
          // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
          const msg = await (channel as any).messages.fetch(msgId);
          if (this.client.user) {
            await msg.reactions.cache.get(this.receiptReaction)?.users.remove(this.client.user.id);
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
}
