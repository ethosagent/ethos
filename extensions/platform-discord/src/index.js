import { deriveBotKey } from '@ethosagent/core';
import { Client, GatewayIntentBits, Partials, REST, Routes } from 'discord.js';
import { chunkText, reflowChunks } from './chunking';
import { COMMAND_DEFINITIONS, dispatch } from './commands';
import { DEFAULT_CHANNEL_MODE } from './config';
import { buildModal, registerInteractionHandler, toActionRowBuilder } from './events/interactions';
import { registerEditHandler, registerMessageHandler } from './events/messages';
import { toNativeMarkdown } from './format';
import { BackfillStateStore } from './store/backfill-state';
import { ChannelOverrideStore } from './store/channel-overrides';
import { ThreadStateStore } from './store/thread-state';

export { chunkText, reflowChunks } from './chunking';
export class DiscordAdapter {
  id;
  displayName = 'Discord';
  canSendTyping = true;
  canEditMessage = true;
  canReact = true;
  canSendFiles = false;
  maxMessageLength = 2000;
  get capabilities() {
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
      outboundFiles: false,
      webhookMode: false,
    };
  }
  botKey;
  client;
  token;
  receiptReaction;
  cache;
  applicationId;
  registerCommandsTo;
  binding;
  defaultChannelMode;
  approvalRoleIds;
  approvalPolicy;
  postThinkingPlaceholder;
  threadState;
  channelOverrides;
  backfillState;
  messageHandler;
  clarifyInteractionHandler;
  approvalDecisionHandler;
  commandContext;
  pendingInteractions = new Map();
  chunkMap = new Map();
  chunkMapMaxEntries = 1024;
  /** Receipt reactions pending clearing, keyed by inbound messageId → channelId. Bounded FIFO. */
  pendingReactions = new Map();
  pendingReactionsMax = 256;
  /** Thinking placeholder messages keyed by chatId → messageId. */
  thinkingMessages = new Map();
  constructor(config) {
    this.token = config.token;
    this.receiptReaction = config.receiptReaction ?? '👀';
    this.botKey = config.botKey ?? deriveBotKey(config.token);
    this.id = `discord:${this.botKey}`;
    this.cache = config.cache;
    this.applicationId = config.applicationId;
    this.registerCommandsTo = config.registerCommandsTo;
    this.binding = config.binding ?? { type: 'personality', name: 'default' };
    this.approvalRoleIds = config.approvalRoleIds ?? [];
    this.approvalPolicy = config.approvalPolicy ?? 'role_gate';
    this.postThinkingPlaceholder = config.postThinkingPlaceholder ?? false;
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
      this.channelOverrides = new ChannelOverrideStore(config.storage, dir, this.botKey);
      this.backfillState = new BackfillStateStore(config.storage, dir, this.botKey);
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
  async start() {
    await this.threadState?.load();
    await this.channelOverrides?.load();
    await this.backfillState?.load();
    const messageCtx = {
      client: this.client,
      botKey: this.botKey,
      defaultChannelMode: this.defaultChannelMode,
      receiptReaction: this.receiptReaction,
      cache: this.cache,
      channelOverrides: this.channelOverrides,
      threadState: this.threadState,
      backfillState: this.backfillState,
      onMessage: (msg) => this.messageHandler?.(msg),
      onReceipt: (channelId, messageId) => {
        if (this.pendingReactions.size >= this.pendingReactionsMax) {
          const oldest = this.pendingReactions.keys().next().value;
          if (oldest !== undefined) this.pendingReactions.delete(oldest);
        }
        this.pendingReactions.set(messageId, channelId);
      },
    };
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
    if (this.applicationId && this.registerCommandsTo) {
      await this.registerSlashCommands();
    }
    await this.client.login(this.token);
  }
  async stop() {
    await this.client.destroy();
  }
  onMessage(handler) {
    this.messageHandler = handler;
  }
  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------
  async send(chatId, message) {
    try {
      await this.clearThinkingPlaceholder(chatId);
      const targetId = message.threadId ?? chatId;
      const channel = await this.client.channels.fetch(targetId);
      if (!channel || !('send' in channel)) {
        return { ok: false, error: 'Channel not found or not sendable' };
      }
      const chunks = chunkText(toNativeMarkdown(message.text), this.maxMessageLength);
      const ids = [];
      for (const chunk of chunks) {
        // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
        const sent = await channel.send({
          content: chunk,
          allowedMentions: { parse: [] },
        });
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
  async sendTyping(chatId) {
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (channel && 'sendTyping' in channel) {
        // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
        await channel.sendTyping();
      }
      if (this.postThinkingPlaceholder && channel && 'send' in channel) {
        if (!this.thinkingMessages.has(chatId)) {
          // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
          const placeholder = await channel.send({
            content: 'Thinking…',
            allowedMentions: { parse: [] },
          });
          this.thinkingMessages.set(chatId, String(placeholder.id));
        }
      }
    } catch {
      // ignore
    }
  }
  async editMessage(chatId, messageId, text) {
    try {
      await this.clearThinkingPlaceholder(chatId);
      const channel = await this.client.channels.fetch(chatId);
      if (!channel || !('messages' in channel) || !('send' in channel)) {
        return { ok: false, error: 'Channel not found' };
      }
      const newChunks = chunkText(toNativeMarkdown(text), this.maxMessageLength);
      const existingIds = this.chunkMap.get(messageId) ?? [messageId];
      const updatedIds = await reflowChunks(newChunks, existingIds, {
        edit: async (id, chunk) => {
          // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
          const msg = await channel.messages.fetch(id);
          const edited = await msg.edit(chunk);
          return String(edited.id);
        },
        append: async (chunk) => {
          // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
          const sent = await channel.send({
            content: chunk,
            allowedMentions: { parse: [] },
          });
          return String(sent.id);
        },
        deleteId: async (id) => {
          // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
          const msg = await channel.messages.fetch(id);
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
  async health() {
    return {
      ok: this.client.ws.status === 0,
      latencyMs: this.client.ws.ping,
    };
  }
  // ---------------------------------------------------------------------------
  // Clarify
  // ---------------------------------------------------------------------------
  async postClarifyCard(input) {
    try {
      const channel = await this.client.channels.fetch(input.chatId);
      if (!channel || !('send' in channel)) return { error: 'Channel not found or not sendable' };
      // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
      const sent = await channel.send({
        content: input.content,
        components: input.components.map(toActionRowBuilder),
        allowedMentions: { parse: [] },
      });
      return { messageId: String(sent.id) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  async updateClarifyCard(input) {
    try {
      const channel = await this.client.channels.fetch(input.chatId);
      if (!channel || !('messages' in channel)) return { ok: false, error: 'Channel not found' };
      // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
      const msg = await channel.messages.fetch(input.messageId);
      await msg.edit({
        content: input.content,
        components: input.components.map(toActionRowBuilder),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  async openClarifyModal(input) {
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
  async ackButtonClick(input) {
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
  async ackModalSubmit(input) {
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
  onClarifyInteraction(handler) {
    this.clarifyInteractionHandler = handler;
  }
  // ---------------------------------------------------------------------------
  // Approval (Move 7)
  // ---------------------------------------------------------------------------
  async postApprovalCard(input) {
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
      const sent = await channel.send({
        embeds: [emb],
        components: [toActionRowBuilder(buttons)],
      });
      return { messageTs: String(sent.id) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  async updateApprovalCard(input) {
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
      const msg = await channel.messages.fetch(input.messageTs);
      await msg.edit({ embeds: [emb], components: [] });
      return { ok: true, messageId: input.messageTs };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  onApprovalDecision(handler) {
    this.approvalDecisionHandler = handler;
  }
  setCommandContext(ctx) {
    this.commandContext = ctx;
  }
  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------
  async handleCommand(payload, interaction) {
    if (!interaction.isChatInputCommand()) return;
    try {
      await interaction.deferReply({ ephemeral: true });
      const ctx = this.commandContext ?? {
        binding: this.binding,
        defaultChannelMode: this.defaultChannelMode,
        channelOverrides: this.channelOverrides,
      };
      const response = await dispatch(payload, ctx);
      await interaction.editReply({
        content: response.content,
        // biome-ignore lint/suspicious/noExplicitAny: embed shape matches Discord API
        embeds: response.embeds,
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
  handleApprovalDecision(approvalId, decision, userId, interaction) {
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
      const memberRoles = member && 'cache' in member.roles ? member.roles.cache : null;
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
  async registerSlashCommands() {
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
  async clearThinkingPlaceholder(chatId) {
    const placeholderId = this.thinkingMessages.get(chatId);
    if (!placeholderId) return;
    this.thinkingMessages.delete(chatId);
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (channel && 'messages' in channel) {
        // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union
        const msg = await channel.messages.fetch(placeholderId);
        await msg.delete();
      }
    } catch {
      // Best-effort cleanup
    }
  }
  async clearReceiptReaction(chatId) {
    // Find all pending reactions belonging to this channel and clear them.
    const toClear = [];
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
          const msg = await channel.messages.fetch(msgId);
          if (this.client.user) {
            await msg.reactions.cache.get(this.receiptReaction)?.users.remove(this.client.user.id);
          }
        }
      }
    } catch {
      // Best-effort reaction removal
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
}
export const capabilities = {
  platform: 'discord',
  typing: true,
  editDetection: true,
  replyToThreading: true,
  persistence: true,
  channelModes: true,
  homeView: true,
  joinGreeting: false,
  roleBasedApprovals: true,
  outboundFiles: false,
  webhookMode: false,
};
