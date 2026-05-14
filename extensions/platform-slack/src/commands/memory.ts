import { memoryAddedBlocks, memoryShowBlocks } from '../blocks/memory';
import { plaintextFallback, section } from '../blocks/shared';
import type { SlashContext, SlashResponse } from './index';

/** Minimal memory shape this slash command consumes. The wiring layer
 *  adapts the personality `MemoryProvider` to this surface so the Slack
 *  package doesn't import `@ethosagent/memory-markdown` directly. */
export interface MemoryReader {
  /** Return the raw `MEMORY.md` body for the current binding's scope. */
  read(): Promise<string | null>;
  /** Append a new entry. The implementation prefixes/formats as it sees
   *  fit; we hand over the text the user typed verbatim. */
  append(text: string): Promise<void>;
}

const SUBCMDS = ['show', 'add'] as const;
type Sub = (typeof SUBCMDS)[number];

export async function handleMemory(rest: string, ctx: SlashContext): Promise<SlashResponse> {
  if (!ctx.memory) {
    const blocks = [section('Memory is unavailable for this bot.')];
    return { blocks, text: plaintextFallback(blocks), responseType: 'ephemeral' };
  }

  const trimmed = rest.trim();
  if (!trimmed) return memoryUsage();
  const [sub, ...args] = trimmed.split(/\s+/);
  const subKey = sub.toLowerCase() as Sub;
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

function memoryUsage(): SlashResponse {
  const blocks = [section('Usage: `/ethos memory show` or `/ethos memory add <text>`')];
  return { blocks, text: plaintextFallback(blocks), responseType: 'ephemeral' };
}

/** Cheap "last N entries" extractor — the markdown memory provider stores
 *  entries as `- ` bullet lines or under `## ` headings. We split on either
 *  separator and return the last `n` non-empty chunks. */
export function extractRecentEntries(body: string | null, n: number): string[] {
  if (!body) return [];
  const lines = body.split('\n');
  const entries: string[] = [];
  let buf: string[] = [];
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
