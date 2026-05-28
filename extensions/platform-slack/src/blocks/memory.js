import { context, divider, header, section } from './shared';
export function memoryShowBlocks(input) {
    if (input.entries.length === 0) {
        return [header('Memory'), section(`Memory for \`${input.scope}\` is empty.`)];
    }
    const blocks = [
        header('Memory'),
        section(`Last ${input.entries.length} entr${input.entries.length === 1 ? 'y' : 'ies'} for \`${input.scope}\`:`),
        divider(),
    ];
    for (const entry of input.entries) {
        blocks.push(section(entry));
    }
    return blocks;
}
export function memoryAddedBlocks(input) {
    return [
        section(`Appended to \`${input.scope}\` MEMORY.md.`),
        context([truncatePreview(input.preview)]),
    ];
}
function truncatePreview(text) {
    const single = text.replace(/\s+/g, ' ').trim();
    if (single.length <= 120)
        return single;
    return `${single.slice(0, 117)}…`;
}
