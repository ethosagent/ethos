import { createHash } from 'node:crypto';
import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  type Message,
  ModalBuilder,
  Partials,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { CLARIFY_MODAL_INPUT_ID, type clarifyModalPayload } from './clarify-blocks';
import {
  type ClarifyButtonPayload,
  type ClarifyInteractionEvent,
  type ClarifyModalPayload,
  handleClarifyButton,
  handleClarifyModal,
} from './clarify-interactions';

// ---------------------------------------------------------------------------
// Text chunking — Discord 2000 char limit
// ---------------------------------------------------------------------------

export function chunkText(text: string, maxLength = 2000): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    const newline = remaining.lastIndexOf('\n', maxLength);
    const cutAt = newline > maxLength * 0.6 ? newline + 1 : maxLength;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt);
  }

  return chunks;
}

/**
 * Re-flow `newChunks` over `existingIds`. Edits the first N chunks in place,
 * appends extras, and deletes trailing existing chunks no longer needed.
 * Delete failures are swallowed (best-effort) — they shouldn't block an edit.
 * Returns the new ordered chunk ids.
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
// DiscordAdapter
// ---------------------------------------------------------------------------

export interface DiscordAdapterConfig {
  token: string;
  /**
   * When true (default), the bot only responds in DMs and when @mentioned.
   * Set to false to respond to every message the bot can see.
   */
  mentionOnly?: boolean;
  /** Stable per-bot identifier — defaults to sha256(token).slice(0,24). */
  botKey?: string;
}

/** First 24 hex chars of sha256(token) — matches `deriveBotKey` in
 *  `apps/ethos/src/config.ts` so an adapter constructed without an explicit
 *  `botKey` round-trips the same identity the boot path would have produced. */
function deriveDefaultBotKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 24);
}

/** Raw clarify interaction event delivered to the surface. */
export interface DiscordClarifyInteraction {
  event: ClarifyInteractionEvent;
  interactionId: string;
  interactionToken: string;
}

export class DiscordAdapter implements PlatformAdapter {
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
  private messageHandler?: (message: InboundMessage) => void;
  /** Clarify-interaction handler, wired by the Discord clarify surface. */
  private clarifyInteractionHandler?: (raw: DiscordClarifyInteraction) => void;
  /** Pending interactions awaiting their first ack — keyed by interactionId.
   *  discord.js's `Interaction` object carries the methods we need (deferUpdate,
   *  showModal, reply); we hold the live object until the surface acks it. */
  private readonly pendingInteractions = new Map<string, Interaction>();
  /**
   * Chunk-id ledger so `editMessage` can re-flow multi-chunk responses.
   * Keyed by the primary (first) chunk id, value = ordered list of all
   * chunk ids in the response. Bounded to `chunkMapMaxEntries` with FIFO
   * eviction so long-running bots don't grow unbounded.
   */
  private readonly chunkMap = new Map<string, string[]>();
  private readonly chunkMapMaxEntries = 1024;

  constructor(config: DiscordAdapterConfig) {
    this.token = config.token;
    this.mentionOnly = config.mentionOnly ?? true;
    this.botKey = config.botKey ?? deriveDefaultBotKey(config.token);
    this.id = `discord:${this.botKey}`;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // requires privileged intent in dev portal
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    // Component / modal interactions for the clarify card. Routed through
    // the pure handlers in `clarify-interactions.ts`; the adapter just
    // shapes the discord.js `Interaction` into the typed payload.
    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      const handler = this.clarifyInteractionHandler;
      if (!handler) return;
      try {
        if (interaction.isButton()) {
          const payload: ClarifyButtonPayload = {
            customId: interaction.customId,
            userId: interaction.user.id,
            channelId: interaction.channelId ?? '',
            messageId: interaction.message.id,
          };
          // Only store the interaction AFTER the pure handler accepts it
          // (calls onEvent). Non-clarify buttons and malformed payloads
          // never reach onEvent, so nothing leaks.
          await handleClarifyButton(payload, {
            onEvent: async (event) => {
              this.pendingInteractions.set(interaction.id, interaction);
              handler({
                event,
                interactionId: interaction.id,
                interactionToken: interaction.token,
              });
            },
          });
        } else if (interaction.isModalSubmit()) {
          const answer = interaction.fields.getTextInputValue(CLARIFY_MODAL_INPUT_ID)?.trim() ?? '';
          const payload: ClarifyModalPayload = {
            customId: interaction.customId,
            userId: interaction.user.id,
            channelId: interaction.channelId ?? '',
            answer,
          };
          await handleClarifyModal(payload, {
            onEvent: async (event) => {
              this.pendingInteractions.set(interaction.id, interaction);
              handler({
                event,
                interactionId: interaction.id,
                interactionToken: interaction.token,
              });
            },
          });
        }
      } catch {
        // Discord is the thing we don't control — a malformed payload or
        // discord.js API drift must not throw inside the event loop.
      }
    });

    this.client.on(Events.MessageCreate, (message: Message) => {
      if (!this.messageHandler) return;
      if (message.author.bot) return;

      const isDm = message.channel.isDMBased();
      const isMention = this.client.user ? message.mentions.has(this.client.user) : false;

      // In servers, only respond when @mentioned (unless mentionOnly=false)
      if (!isDm && this.mentionOnly && !isMention) return;

      // Strip the @mention prefix from the message text
      let text = message.content;
      if (this.client.user) {
        text = text.replace(`<@${this.client.user.id}>`, '').trim();
      }

      const msg: InboundMessage = {
        platform: 'discord',
        chatId: message.channelId,
        userId: message.author.id,
        username: message.author.username,
        text,
        isDm,
        isGroupMention: isMention && !isDm,
        replyToId: message.reference?.messageId ?? undefined,
        replyToUserId: message.mentions.repliedUser?.id ?? undefined,
        messageId: message.id,
        raw: message,
      };

      this.messageHandler(msg);
    });

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
      const channel = await this.client.channels.fetch(chatId);
      if (!channel || !('send' in channel)) {
        return { ok: false, error: 'Channel not found or not sendable' };
      }

      const chunks = chunkText(message.text, this.maxMessageLength);
      const ids: string[] = [];

      for (const chunk of chunks) {
        // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union excludes PartialGroupDM
        const sent = await (channel as any).send({ content: chunk });
        ids.push(String(sent.id));
      }

      this.rememberChunkIds(ids);
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

      // Re-key the map under the (possibly new) first id, drop the old key
      // when it changed, so future edits still resolve.
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
    return {
      ok: this.client.ws.status === 0,
      latencyMs: this.client.ws.ping,
    };
  }

  // ---------------------------------------------------------------------------
  // Clarify cards (interactive question/answer)
  //
  // Mirrors `SlackAdapter`'s clarify methods. The Discord clarify surface
  // drives them: post a card with Button components when the agent calls
  // `clarify`, edit the card in place (components removed) once resolved.
  // ---------------------------------------------------------------------------

  /** Post the pending clarify card. Returns the message id so the surface
   *  can later edit it in place to the resolved state. */
  async postClarifyCard(input: {
    chatId: string;
    content: string;
    components: unknown[];
  }): Promise<{ messageId: string } | { error: string }> {
    try {
      const channel = await this.client.channels.fetch(input.chatId);
      if (!channel || !('send' in channel)) return { error: 'Channel not found or not sendable' };
      // biome-ignore lint/suspicious/noExplicitAny: discord.js channel union excludes PartialGroupDM
      const sent = await (channel as any).send({
        content: input.content,
        components: input.components.map(toActionRowBuilder),
      });
      return { messageId: String(sent.id) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Replace the card with its resolved state — components removed. */
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

  /** Open the free-form modal via the pending interaction. The interaction
   *  must be a button click (we use `interaction.showModal`). The interaction
   *  is removed from `pendingInteractions` once consumed. */
  async openClarifyModal(input: {
    interactionId: string;
    interactionToken: string;
    modal: ReturnType<typeof clarifyModalPayload>;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    void input.interactionToken; // discord.js looks up via interactionId
    const pending = this.pendingInteractions.get(input.interactionId);
    if (!pending?.isButton()) {
      return { ok: false, error: 'No pending button interaction for this id' };
    }
    this.pendingInteractions.delete(input.interactionId);
    try {
      const modal = new ModalBuilder()
        .setCustomId(input.modal.custom_id)
        .setTitle(input.modal.title);
      for (const row of input.modal.components) {
        const arBuilder = new ActionRowBuilder<TextInputBuilder>();
        for (const el of row.components) {
          arBuilder.addComponents(
            new TextInputBuilder()
              .setCustomId(el.custom_id)
              .setLabel(el.label)
              .setStyle(el.style === 1 ? TextInputStyle.Short : TextInputStyle.Paragraph)
              .setRequired(el.required),
          );
        }
        modal.addComponents(arBuilder);
      }
      await pending.showModal(modal);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Acknowledge a button click with `deferUpdate()` (the no-visible-change
   *  ack discord.js requires within 3s). Drains the pending entry so the
   *  Interaction object is released. Callers using the open-modal path
   *  must call `openClarifyModal` INSTEAD of this — `showModal` is the
   *  first response for that path, and `deferUpdate` consumes the response
   *  window. */
  async ackButtonClick(input: { interactionId: string; interactionToken: string }): Promise<void> {
    void input.interactionToken;
    const pending = this.pendingInteractions.get(input.interactionId);
    if (!pending?.isButton()) return;
    this.pendingInteractions.delete(input.interactionId);
    try {
      await pending.deferUpdate();
    } catch {
      // Best-effort — Discord rejects double-ack. Swallow.
    }
  }

  /** Acknowledge a modal submission. */
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

  /** Register the clarify-interaction handler. Called by the Discord
   *  clarify surface in its constructor. */
  onClarifyInteraction(handler: (raw: DiscordClarifyInteraction) => void): void {
    this.clarifyInteractionHandler = handler;
  }
}

/**
 * Convert a serialized API action row into a discord.js `ActionRowBuilder`.
 * Used by `postClarifyCard` / `updateClarifyCard` so the pure builders in
 * `clarify-blocks.ts` don't need to depend on discord.js's class hierarchy.
 */
function toActionRowBuilder(row: unknown): ActionRowBuilder<ButtonBuilder> {
  const r = row as {
    type: number;
    components: Array<{ style: number; label: string; custom_id: string }>;
  };
  const ar = new ActionRowBuilder<ButtonBuilder>();
  for (const c of r.components) {
    ar.addComponents(
      new ButtonBuilder()
        .setCustomId(c.custom_id)
        .setLabel(c.label)
        .setStyle(buttonStyleFromInt(c.style)),
    );
  }
  return ar;
}

function buttonStyleFromInt(n: number): ButtonStyle {
  switch (n) {
    case 1:
      return ButtonStyle.Primary;
    case 2:
      return ButtonStyle.Secondary;
    case 3:
      return ButtonStyle.Success;
    case 4:
      return ButtonStyle.Danger;
    default:
      return ButtonStyle.Secondary;
  }
}
