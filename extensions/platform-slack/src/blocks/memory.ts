import { context, divider, header, type SlackBlock, section } from './shared';

export function memoryShowBlocks(input: { scope: string; entries: string[] }): SlackBlock[] {
  if (input.entries.length === 0) {
    return [header('Memory'), section(`Memory for \`${input.scope}\` is empty.`)];
  }
  const blocks: SlackBlock[] = [
    header('Memory'),
    section(
      `Last ${input.entries.length} entr${input.entries.length === 1 ? 'y' : 'ies'} for \`${input.scope}\`:`,
    ),
    divider(),
  ];
  for (const entry of input.entries) {
    blocks.push(section(entry));
  }
  return blocks;
}

export function memoryAddedBlocks(input: { scope: string; preview: string }): SlackBlock[] {
  return [
    section(`Appended to \`${input.scope}\` MEMORY.md.`),
    context([truncatePreview(input.preview)]),
  ];
}

function truncatePreview(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= 120) return single;
  return `${single.slice(0, 117)}…`;
}
