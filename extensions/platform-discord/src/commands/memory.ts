import { memoryEmbed } from '../blocks/memory';
import { embed } from '../blocks/shared';
import type { CommandContext, CommandPayload, CommandResponse } from './index';

export async function handleMemory(
  payload: CommandPayload,
  ctx: CommandContext,
): Promise<CommandResponse> {
  const action = payload.options.action || 'show';
  if (!ctx.memory) {
    return { embeds: [embed({ description: 'Memory not available.' })], ephemeral: true };
  }
  if (action === 'clear') {
    await ctx.memory.clear('memory');
    return {
      embeds: [embed({ title: 'Memory Cleared', description: 'Memory has been cleared.' })],
      ephemeral: true,
    };
  }
  const entries = await ctx.memory.read('both');
  return { embeds: [memoryEmbed(entries, 'both')], ephemeral: true };
}
