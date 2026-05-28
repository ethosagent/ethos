import { memoryAddedBlocks, memoryShowBlocks } from '../blocks/memory';
import { plaintextFallback, section } from '../blocks/shared';

const SUBCMDS = ['show', 'add'];
export async function handleMemory(rest, ctx) {
  if (!ctx.memory) {
    const blocks = [section('Memory is unavailable for this bot.')];
    return { blocks, text: plaintextFallback(blocks), responseType: 'ephemeral' };
  }
  const trimmed = rest.trim();
  if (!trimmed) return memoryUsage();
  const [sub, ...args] = trimmed.split(/\s+/);
  const subKey = sub.toLowerCase();
  if (!SUBCMDS.includes(subKey)) return memoryUsage();
  if (subKey === 'show') {
    const body = await ctx.memory.read();
    const entries = extractRecentEntries(body, 5);
    const blocks = memoryShowBlocks({ scope: ctx.binding.name, entries });
    return { blocks, text: plaintextFallback(blocks), responseType: 'ephemeral' };
  }
  // 'add'
  const text = args.join(' ').trim();
  if (!text) {
    const blocks = [section('Usage: `/ethos memory add <text>`')];
    return { blocks, text: plaintextFallback(blocks), responseType: 'ephemeral' };
  }
  await ctx.memory.append(text);
  const blocks = memoryAddedBlocks({ scope: ctx.binding.name, preview: text });
  return { blocks, text: plaintextFallback(blocks), responseType: 'ephemeral' };
}
function memoryUsage() {
  const blocks = [section('Usage: `/ethos memory show` or `/ethos memory add <text>`')];
  return { blocks, text: plaintextFallback(blocks), responseType: 'ephemeral' };
}
/** Cheap "last N entries" extractor — the markdown memory provider stores
 *  entries as `- ` bullet lines or under `## ` headings. We split on either
 *  separator and return the last `n` non-empty chunks. */
export function extractRecentEntries(body, n) {
  if (!body) return [];
  const lines = body.split('\n');
  const entries = [];
  let buf = [];
  const flush = () => {
    const joined = buf.join('\n').trim();
    if (joined) entries.push(joined);
    buf = [];
  };
  for (const line of lines) {
    if (/^(##\s|-\s|\*\s)/.test(line)) {
      flush();
      buf.push(line);
    } else {
      buf.push(line);
    }
  }
  flush();
  return entries.slice(-n);
}
