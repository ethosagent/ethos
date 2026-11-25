import {
  channelModeSetBlocks,
  channelModeShowBlocks,
  channelModeUsageBlocks,
} from '../blocks/channel-mode';
import { plaintextFallback, section } from '../blocks/shared';
import { ChannelModeSchema } from '../config';
import type { SlashContext, SlashResponse } from './index';
import { slashChannelMode } from './mode';

export async function handleChannelMode(
  channel: string,
  rest: string,
  ctx: SlashContext,
): Promise<SlashResponse> {
  const arg = rest.trim().toLowerCase();

  if (!arg || arg === 'show') {
    const { mode, source } = slashChannelMode(channel, ctx);
    const blocks = channelModeShowBlocks({ channel, mode, source });
    return { blocks, text: plaintextFallback(blocks), responseType: 'ephemeral' };
  }

  const parsed = ChannelModeSchema.safeParse(arg);
  if (!parsed.success) {
    const blocks = channelModeUsageBlocks();
    return { blocks, text: plaintextFallback(blocks), responseType: 'ephemeral' };
  }

  if (!ctx.channelOverrides) {
    const fallback = [section('Channel-mode persistence is not configured.')];
    return { blocks: fallback, text: plaintextFallback(fallback), responseType: 'ephemeral' };
  }

  await ctx.channelOverrides.set(channel, parsed.data);
  const blocks = channelModeSetBlocks({ channel, mode: parsed.data });
  return { blocks, text: plaintextFallback(blocks), responseType: 'ephemeral' };
}
