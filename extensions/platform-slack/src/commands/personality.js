import { personalityBlocks, personalityRichBlocks, } from '../blocks/personality';
import { plaintextFallback } from '../blocks/shared';
export async function handlePersonality(rest, ctx) {
    // `/ethos personality rich` — the full character sheet. Only meaningful
    // for personality bindings (team coordinators have no single sheet) and
    // only when the wiring layer supplied a reader; otherwise fall through to
    // the compact binding view.
    if (rest.trim().toLowerCase() === 'rich' &&
        ctx.personalityCard &&
        ctx.binding.type === 'personality') {
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
