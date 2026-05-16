import { type DiscordEmbed, embed, field, truncate } from './shared';

export interface KanbanItem {
  id: string;
  title: string;
  status: string;
}

export function kanbanEmbed(items: KanbanItem[]): DiscordEmbed {
  if (items.length === 0) {
    return embed({ title: 'Kanban', description: 'No open tickets.' });
  }
  const fields = items
    .slice(0, 25)
    .map((item) => field(truncate(item.title, 256), `\`${item.status}\` · ${item.id}`, true));
  return embed({ title: 'Kanban', description: `${items.length} ticket(s)`, fields });
}
