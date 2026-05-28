import { plaintextFallback, section } from '../blocks/shared';
export async function handleAsk(payload, rest, ctx) {
    const prompt = rest.trim();
    if (!prompt) {
        const blocks = [section('Usage: `/ethos ask <prompt>`')];
        return { blocks, text: plaintextFallback(blocks), responseType: 'ephemeral' };
    }
    if (!ctx.submitAgentTurn) {
        const blocks = [section('Agent submission is not configured.')];
        return { blocks, text: plaintextFallback(blocks), responseType: 'ephemeral' };
    }
    // Fire and forget — the agent's response flows back through the gateway's
    // normal outbound path (chat.postMessage), not through the slash command's
    // synchronous reply. We post a tiny in-channel acknowledgement so the
    // user knows the command landed; the answer arrives via the agent loop.
    await ctx.submitAgentTurn({
        channel: payload.channel_id,
        user: payload.user_id,
        text: prompt,
    });
    const blocks = [section(`<@${payload.user_id}> asked: ${quoteSnippet(prompt)}`)];
    return { blocks, text: plaintextFallback(blocks), responseType: 'in_channel' };
}
function quoteSnippet(text) {
    const single = text.replace(/\s+/g, ' ').trim();
    if (single.length <= 200)
        return `_${single}_`;
    return `_${single.slice(0, 197)}…_`;
}
