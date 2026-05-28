import { kanbanListBlocks, kanbanUnavailableBlocks } from '../blocks/kanban';
import { plaintextFallback } from '../blocks/shared';
export async function handleKanban(ctx) {
    if (ctx.binding.type !== 'team') {
        const blocks = kanbanUnavailableBlocks('this bot is bound to a personality, not a team. Kanban is a team feature.');
        return { blocks, text: plaintextFallback(blocks), responseType: 'ephemeral' };
    }
    if (!ctx.kanban) {
        const blocks = kanbanUnavailableBlocks('the kanban store is not wired into this adapter.');
        return { blocks, text: plaintextFallback(blocks), responseType: 'ephemeral' };
    }
    const tickets = await ctx.kanban.listOpenTickets();
    const blocks = kanbanListBlocks({ team: ctx.binding.name, tickets });
    return { blocks, text: plaintextFallback(blocks), responseType: 'ephemeral' };
}
