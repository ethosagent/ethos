import { embed } from '../blocks/shared';
export async function handleAsk(payload, ctx) {
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
