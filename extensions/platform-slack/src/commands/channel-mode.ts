import {
  channelModeSetBlocks,
  channelModeShowBlocks,
  channelModeUsageBlocks,
} from '../blocks/channel-mode';
import { plaintextFallback, section } from '../blocks/shared';
import { ChannelModeSchema } from '../config';
import { resolveChannelMode } from '../routing/triage';
import type { SlashContext, SlashResponse } from './index';

export async function handleChannelMode(
  channel: string,
  rest: string,
  ctx: SlashContext,
): Promise<SlashResponse> {
  const arg = rest.trim().toLowerCase();

  if (!arg || arg === 'show') {
    const mode = resolveChannelMode(channel, {
      botKey: '',
      defaultChannelMode: ctx.defaultChannelMode,
      channelOverrides: ctx.channelOverrides,
    });
    const isOverride = ctx.channelOverrides?.get(channel) !== undefined;
    const blocks = channelModeShowBlocks({ channel, mode, isOverride });
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
