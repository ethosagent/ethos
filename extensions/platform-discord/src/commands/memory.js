import { memoryEmbed } from '../blocks/memory';
import { embed } from '../blocks/shared';
export async function handleMemory(payload, ctx) {
  const action = payload.options.action || 'show';
  if (!ctx.memory) {
    return { embeds: [embed({ description: 'Memory not available.' })], ephemeral: true };
  }
  // Authorization gate — only allowed users may view or modify memory.
  // Memory content (USER.md) can contain sensitive personal data; exposing
  // it to any caller in a shared server would be an information leak.
  if (!ctx.allowedUsers?.includes(payload.userId)) {
    return {
      embeds: [embed({ description: 'You are not authorized to access memory.' })],
      ephemeral: true,
    };
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
