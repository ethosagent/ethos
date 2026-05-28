import { helpBlocks } from '../blocks/help';
import { plaintextFallback } from '../blocks/shared';
import { resolveChannelMode } from '../routing/triage';
export function handleHelp(channel, ctx) {
    const channelMode = resolveChannelMode(channel, {
        botKey: '',
        defaultChannelMode: ctx.defaultChannelMode,
        channelOverrides: ctx.channelOverrides,
    });
    const blocks = helpBlocks({ binding: ctx.binding, channel, channelMode });
    return {
        blocks,
        text: plaintextFallback(blocks),
        responseType: 'ephemeral',
    };
}
export function unknownSubcommandResponse(rest, ctx, channel) {
    const head = rest.split(/\s+/)[0] ?? '';
    const help = handleHelp(channel, ctx);
    return {
        ...help,
        text: `Unknown subcommand: \`${head}\`. ${help.text}`,
    };
}
