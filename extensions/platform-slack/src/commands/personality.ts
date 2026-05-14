import { personalityBlocks } from '../blocks/personality';
import { plaintextFallback } from '../blocks/shared';
import type { SlashContext, SlashResponse } from './index';

export function handlePersonality(ctx: SlashContext): SlashResponse {
  const blocks = personalityBlocks(ctx.binding);
  return {
    blocks,
    text: plaintextFallback(blocks),
    responseType: 'ephemeral',
  };
}
