import type { Interaction } from 'discord.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { CLARIFY_MODAL_INPUT_ID, type clarifyModalPayload } from '../clarify-blocks';
import {
  type ClarifyButtonPayload,
  type ClarifyModalPayload,
  handleClarifyButton,
  handleClarifyModal,
} from '../clarify-interactions';
import type { CommandPayload } from '../commands';
import type { DiscordClarifyInteraction } from '../types';

interface InteractionContext {
  pendingInteractions: Map<string, Interaction>;
  onClarifyInteraction?: (raw: DiscordClarifyInteraction) => void;
  onCommand?: (payload: CommandPayload, interaction: Interaction) => void;
  onApprovalDecision?: (
    approvalId: string,
    decision: 'allow' | 'deny',
    userId: string,
    interaction: Interaction,
  ) => void;
}

export function registerInteractionHandler(
  client: { on: (event: string, handler: (interaction: Interaction) => void) => void },
  ctx: InteractionContext,
): void {
  client.on('interactionCreate', async (interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        handleSlashCommand(interaction, ctx);
        return;
      }

      if (interaction.isButton()) {
        const customId = interaction.customId;

        // Approval buttons
        if (customId.startsWith('ethos:approve:') || customId.startsWith('ethos:deny:')) {
          const decision = customId.startsWith('ethos:approve:') ? 'allow' : 'deny';
          const approvalId = customId.split(':').slice(2).join(':');
          if (ctx.onApprovalDecision) {
            ctx.onApprovalDecision(approvalId, decision, interaction.user.id, interaction);
          }
          return;
        }

        // Clarify buttons
        if (ctx.onClarifyInteraction) {
          const payload: ClarifyButtonPayload = {
            customId: interaction.customId,
            userId: interaction.user.id,
            channelId: interaction.channelId ?? '',
            messageId: interaction.message.id,
          };
          await handleClarifyButton(payload, {
            onEvent: async (event) => {
              ctx.pendingInteractions.set(interaction.id, interaction);
              ctx.onClarifyInteraction?.({
                event,
                interactionId: interaction.id,
                interactionToken: interaction.token,
              });
            },
          });
        }
        return;
      }

      if (interaction.isModalSubmit()) {
        if (!ctx.onClarifyInteraction) return;
        const answer = interaction.fields.getTextInputValue(CLARIFY_MODAL_INPUT_ID)?.trim() ?? '';
        const payload: ClarifyModalPayload = {
          customId: interaction.customId,
          userId: interaction.user.id,
          channelId: interaction.channelId ?? '',
          answer,
        };
        await handleClarifyModal(payload, {
          onEvent: async (event) => {
            ctx.pendingInteractions.set(interaction.id, interaction);
            ctx.onClarifyInteraction?.({
              event,
              interactionId: interaction.id,
              interactionToken: interaction.token,
            });
          },
        });
      }
    } catch {
      // Discord events must not throw into the event loop.
    }
  });
}

function handleSlashCommand(interaction: Interaction, ctx: InteractionContext): void {
  if (!interaction.isChatInputCommand()) return;

  const subcommand = interaction.options.getSubcommand(false);
  const options: Record<string, string> = {};

  if (interaction.options.data.length > 0) {
    const sub = interaction.options.data[0];
    if (sub.options) {
      for (const opt of sub.options) {
        if (opt.value !== undefined) {
          options[opt.name] = String(opt.value);
        }
      }
    }
  }

  const payload: CommandPayload = {
    commandName: subcommand ?? interaction.commandName,
    options,
    channelId: interaction.channelId ?? '',
    userId: interaction.user.id,
    guildId: interaction.guildId ?? undefined,
  };

  ctx.onCommand?.(payload, interaction);
}

export function buildModal(input: ReturnType<typeof clarifyModalPayload>): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(input.custom_id).setTitle(input.title);
  for (const row of input.components) {
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
  return modal;
}

export function toActionRowBuilder(row: unknown): ActionRowBuilder<ButtonBuilder> {
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
