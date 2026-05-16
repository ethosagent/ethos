import { embed } from '../blocks/shared';
import type { CommandContext, CommandPayload, CommandResponse } from './index';

export async function handleAsk(
  payload: CommandPayload,
  ctx: CommandContext,
): Promise<CommandResponse> {
  const prompt = payload.options.prompt;
  if (!prompt) {
    return { embeds: [embed({ description: 'Please provide a prompt.' })], ephemeral: true };
  }
  if (ctx.submitAgentTurn) {
    await ctx.submitAgentTurn({ channel: payload.channelId, user: payload.userId, text: prompt });
    return { embeds: [embed({ description: `Submitted: "${prompt}"` })], ephemeral: true };
  }
  return {
    embeds: [embed({ description: 'Agent turn submission not available.' })],
    ephemeral: true,
  };
}
