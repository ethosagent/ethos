import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, } from 'discord.js';
import { CLARIFY_MODAL_INPUT_ID } from '../clarify-blocks';
import { handleClarifyButton, handleClarifyModal, } from '../clarify-interactions';
export function registerInteractionHandler(client, ctx) {
    client.on('interactionCreate', async (interaction) => {
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
                    const payload = {
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
                if (!ctx.onClarifyInteraction)
                    return;
                const answer = interaction.fields.getTextInputValue(CLARIFY_MODAL_INPUT_ID)?.trim() ?? '';
                const payload = {
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
        }
        catch {
            // Discord events must not throw into the event loop.
        }
    });
}
function handleSlashCommand(interaction, ctx) {
    if (!interaction.isChatInputCommand())
        return;
    const subcommand = interaction.options.getSubcommand(false);
    const options = {};
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
    const payload = {
        commandName: subcommand ?? interaction.commandName,
        options,
        channelId: interaction.channelId ?? '',
        userId: interaction.user.id,
        guildId: interaction.guildId ?? undefined,
    };
    ctx.onCommand?.(payload, interaction);
}
export function buildModal(input) {
    const modal = new ModalBuilder().setCustomId(input.custom_id).setTitle(input.title);
    for (const row of input.components) {
        const arBuilder = new ActionRowBuilder();
        for (const el of row.components) {
            arBuilder.addComponents(new TextInputBuilder()
                .setCustomId(el.custom_id)
                .setLabel(el.label)
                .setStyle(el.style === 1 ? TextInputStyle.Short : TextInputStyle.Paragraph)
                .setRequired(el.required));
        }
        modal.addComponents(arBuilder);
    }
    return modal;
}
export function toActionRowBuilder(row) {
    const r = row;
    const ar = new ActionRowBuilder();
    for (const c of r.components) {
        ar.addComponents(new ButtonBuilder()
            .setCustomId(c.custom_id)
            .setLabel(c.label)
            .setStyle(buttonStyleFromInt(c.style)));
    }
    return ar;
}
function buttonStyleFromInt(n) {
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
