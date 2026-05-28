import { personalityEmbed } from '../blocks/personality';
import { embed } from '../blocks/shared';
export async function handlePersonality(payload, ctx) {
    const action = payload.options.action || 'list';
    if (!ctx.personalityCard) {
        return { embeds: [embed({ description: 'Personality info not available.' })], ephemeral: true };
    }
    if (action === 'list') {
        const items = await ctx.personalityCard.list();
        if (items.length === 0) {
            return { embeds: [embed({ description: 'No personalities available.' })], ephemeral: true };
        }
        const desc = items.map((p) => `• **${p.name}** — ${p.description}`).join('\n');
        return { embeds: [embed({ title: 'Personalities', description: desc })], ephemeral: true };
    }
    const card = await ctx.personalityCard.get();
    if (!card) {
        return { embeds: [embed({ description: 'No active personality.' })], ephemeral: true };
    }
    return { embeds: [personalityEmbed(card)], ephemeral: true };
}
