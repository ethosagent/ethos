import { kanbanEmbed } from '../blocks/kanban';
import { embed } from '../blocks/shared';
export async function handleKanban(_payload, ctx) {
    if (!ctx.kanban) {
        return { embeds: [embed({ description: 'Kanban not available.' })], ephemeral: true };
    }
    const items = await ctx.kanban.list();
    return { embeds: [kanbanEmbed(items)], ephemeral: true };
}
