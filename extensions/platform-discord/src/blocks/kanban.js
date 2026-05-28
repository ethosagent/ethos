import { embed, field, truncate } from './shared';
export function kanbanEmbed(items) {
  if (items.length === 0) {
    return embed({ title: 'Kanban', description: 'No open tickets.' });
  }
  const fields = items
    .slice(0, 25)
    .map((item) => field(truncate(item.title, 256), `\`${item.status}\` · ${item.id}`, true));
  return embed({ title: 'Kanban', description: `${items.length} ticket(s)`, fields });
}
