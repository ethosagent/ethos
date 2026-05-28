import { helpEmbed } from '../blocks/help';
import { DEFAULT_CHANNEL_MODE } from '../config';
export function handleHelp(payload, ctx) {
  const channelMode =
    ctx.channelOverrides?.get(payload.channelId) ?? ctx.defaultChannelMode ?? DEFAULT_CHANNEL_MODE;
  return {
    embeds: [helpEmbed({ binding: ctx.binding, channelId: payload.channelId, channelMode })],
    ephemeral: true,
  };
}
