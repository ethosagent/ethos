import { plaintextFallback, section } from '../blocks/shared';
import { canSpeakInChannel, isSlackDm } from '../routing/triage';
import type { SlashCommandPayload, SlashContext, SlashResponse } from './index';
import { slashChannelMode } from './mode';

const ephemeral = (text: string): SlashResponse => {
  const blocks = [section(text)];
  return { blocks, text: plaintextFallback(blocks), responseType: 'ephemeral' };
};

/**
 * `/ethos channel [show]` (plan channel-prompts §3.12): forwards the text
 * `/channel` or `/channel show` through `submitAgentTurn`, so the gateway's own
 * `/channel` command answers in the thread. The owner-only / DM-only rule for
 * `show` is enforced by the gateway (`channelShowAccess` in
 * extensions/gateway/src/channel-command.ts), never here: this layer only
 * forwards, and a Slack user id is not the gateway's notion of the owner.
 * Like `/ethos ask`, it is refused in a room whose mode forbids posting, since
 * the gateway's reply is a public `chat.postMessage`.
 */
export async function handleChannel(
  payload: SlashCommandPayload,
  rest: string,
  ctx: SlashContext,
): Promise<SlashResponse> {
  const arg = rest.trim().toLowerCase();
  if (arg !== '' && arg !== 'show') return ephemeral('Usage: `/ethos channel [show]`');

  const { mode: channelMode } = slashChannelMode(payload.channel_id, ctx, payload.channel_name);
  const isDm = isSlackDm(payload.channel_id, payload.channel_name);
  if (!canSpeakInChannel(channelMode, isDm)) {
    return ephemeral(
      `This channel is in \`${channelMode}\` mode, so I don't post here. ` +
        'Ask me in a DM, or change the mode with `/ethos channel-mode`.',
    );
  }
  if (!ctx.submitAgentTurn) return ephemeral('Agent submission is not configured.');

  await ctx.submitAgentTurn({
    channel: payload.channel_id,
    user: payload.user_id,
    text: arg === 'show' ? '/channel show' : '/channel',
    isDm,
  });
  return ephemeral('Looking up this room’s policy. The answer follows in the thread.');
}
