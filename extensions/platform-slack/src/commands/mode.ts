import { isSlackDm, resolveChannelModeSource } from '../routing/triage';
import type { SlashContext } from './index';

/**
 * The mode (and which layer supplied it) a slash command reports for a channel.
 * Goes through the same `resolveChannelModeSource` triage uses, fed the same
 * room default and configured-default flag the adapter holds, so
 * `/ethos ask` and `/ethos channel-mode show` cannot disagree with triage.
 */
export function slashChannelMode(
  channel: string,
  ctx: Pick<
    SlashContext,
    'defaultChannelMode' | 'defaultChannelModeConfigured' | 'roomModeDefault' | 'channelOverrides'
  >,
  channelName?: string,
): ReturnType<typeof resolveChannelModeSource> {
  return resolveChannelModeSource(
    channel,
    {
      botKey: '',
      defaultChannelMode: ctx.defaultChannelMode,
      ...(ctx.defaultChannelModeConfigured ? { defaultChannelModeConfigured: true } : {}),
      ...(ctx.roomModeDefault ? { roomModeDefault: ctx.roomModeDefault } : {}),
      ...(ctx.channelOverrides ? { channelOverrides: ctx.channelOverrides } : {}),
    },
    { isDm: isSlackDm(channel, channelName) },
  );
}
