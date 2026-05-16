import { kanbanEmbed } from '../blocks/kanban';
import { embed } from '../blocks/shared';
import type { CommandContext, CommandPayload, CommandResponse } from './index';

export async function handleKanban(
  _payload: CommandPayload,
  ctx: CommandContext,
): Promise<CommandResponse> {
  if (!ctx.kanban) {
    return { embeds: [embed({ description: 'Kanban not available.' })], ephemeral: true };
  }
  const items = await ctx.kanban.list();
  return { embeds: [kanbanEmbed(items)], ephemeral: true };
}
