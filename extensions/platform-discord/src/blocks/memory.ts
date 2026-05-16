import { type DiscordEmbed, embed, truncate } from './shared';

export interface MemoryEntry {
  content: string;
  updatedAt?: string;
}

export function memoryEmbed(
  entries: MemoryEntry[],
  store: 'memory' | 'user' | 'both',
): DiscordEmbed {
  if (entries.length === 0) {
    return embed({ title: 'Memory', description: `No ${store} memory entries.` });
  }
  const lines = entries.map((e, i) => {
    const ts = e.updatedAt ? ` _(${e.updatedAt})_` : '';
    return `${i + 1}. ${truncate(e.content, 200)}${ts}`;
  });
  return embed({
    title: `Memory (${store})`,
    description: truncate(lines.join('\n'), 4096),
  });
}
