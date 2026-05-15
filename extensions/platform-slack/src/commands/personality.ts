import {
  type PersonalityCard,
  personalityBlocks,
  personalityRichBlocks,
} from '../blocks/personality';
import { plaintextFallback } from '../blocks/shared';
import type { SlashContext, SlashResponse } from './index';

/** Resolves the rich character-sheet data for a personality. The wiring
 *  layer adapts the personality registry + skills resolver to this surface
 *  so the Slack package doesn't import `@ethosagent/personalities` or
 *  `@ethosagent/skills` directly. */
export interface PersonalityCardReader {
  /** Returns the card for a personality id, or `null` when it can't be loaded. */
  read(personalityId: string): Promise<PersonalityCard | null>;
}

export async function handlePersonality(rest: string, ctx: SlashContext): Promise<SlashResponse> {
  // `/ethos personality rich` — the full character sheet. Only meaningful
  // for personality bindings (team coordinators have no single sheet) and
  // only when the wiring layer supplied a reader; otherwise fall through to
  // the compact binding view.
  if (
    rest.trim().toLowerCase() === 'rich' &&
    ctx.personalityCard &&
    ctx.binding.type === 'personality'
  ) {
    const card = await ctx.personalityCard.read(ctx.binding.name);
    if (card) {
      const blocks = personalityRichBlocks(card);
      return { blocks, text: plaintextFallback(blocks), responseType: 'ephemeral' };
    }
  }

  const blocks = personalityBlocks(ctx.binding);
  return {
    blocks,
    text: plaintextFallback(blocks),
    responseType: 'ephemeral',
  };
}
