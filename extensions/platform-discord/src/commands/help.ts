import { helpEmbed } from '../blocks/help';
import { DEFAULT_CHANNEL_MODE } from '../config';
import { resolveChannelMode } from '../routing/triage';
import {
  type CommandContext,
  type CommandPayload,
  type CommandResponse,
  commandRoom,
} from './index';

export function handleHelp(payload: CommandPayload, ctx: CommandContext): CommandResponse {
  const room = commandRoom(payload);
  const channelMode = resolveChannelMode(
    room.chatId,
    {
      botKey: '',
      defaultChannelMode: ctx.defaultChannelMode ?? DEFAULT_CHANNEL_MODE,
      defaultChannelModeConfigured: ctx.defaultChannelModeConfigured,
      roomModeDefault: ctx.roomModeDefault,
      channelOverrides: ctx.channelOverrides,
    },
    { isDm: !payload.guildId, ...(room.threadId ? { threadId: room.threadId } : {}) },
  );
  return {
    embeds: [helpEmbed({ binding: ctx.binding, channelId: payload.channelId, channelMode })],
    ephemeral: true,
  };
}
