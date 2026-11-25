import { helpBlocks } from '../blocks/help';
import { plaintextFallback } from '../blocks/shared';
import type { SlashContext, SlashResponse } from './index';
import { slashChannelMode } from './mode';

export function handleHelp(channel: string, ctx: SlashContext): SlashResponse {
  const { mode: channelMode } = slashChannelMode(channel, ctx);
  const blocks = helpBlocks({ binding: ctx.binding, channel, channelMode });
  return {
    blocks,
    text: plaintextFallback(blocks),
    responseType: 'ephemeral',
  };
}

export function unknownSubcommandResponse(
  rest: string,
  ctx: SlashContext,
  channel: string,
): SlashResponse {
  const head = rest.split(/\s+/)[0] ?? '';
  const help = handleHelp(channel, ctx);
  return {
    ...help,
    text: `Unknown subcommand: \`${head}\`. ${help.text}`,
  };
}
