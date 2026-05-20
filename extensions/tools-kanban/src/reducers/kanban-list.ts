import type { ToolReducerContext, ToolResult, ToolResultReducer } from '@ethosagent/types';

const MAX_TICKETS_PASSTHROUGH = 10;
const TOP_OPEN_COUNT = 5;

interface KanbanTicket {
  status?: string;
  updatedAt?: string;
  id?: string;
  title?: string;
}

export const kanbanListReducer: ToolResultReducer = {
  toolName: 'kanban_list',
  reduce(result: ToolResult, _ctx: ToolReducerContext): ToolResult {
    if (!result.ok) return result;
    let tickets: KanbanTicket[];
    try {
      const parsed = JSON.parse(result.value);
      if (!Array.isArray(parsed)) return result;
      tickets = parsed as KanbanTicket[];
    } catch {
      return result;
    }
    if (tickets.length <= MAX_TICKETS_PASSTHROUGH) return result;
    const counts: Record<string, number> = {};
    for (const t of tickets) {
      const s = t.status ?? 'unknown';
      counts[s] = (counts[s] ?? 0) + 1;
    }
    const countStr = Object.entries(counts)
      .map(([s, n]) => `${s}=${n}`)
      .join(', ');
    const open = tickets
      .filter((t) => t.status !== 'done')
      .sort((a, b) => {
        const aDate = a.updatedAt ?? '';
        const bDate = b.updatedAt ?? '';
        return bDate < aDate ? -1 : bDate > aDate ? 1 : 0;
      })
      .slice(0, TOP_OPEN_COUNT);
    const topStr = open.map((t) => `${t.id ?? '?'}: ${t.title ?? '(no title)'}`).join('; ');
    return {
      ok: true,
      value: `Counts by status: ${countStr}. Top ${open.length} open: ${topStr}`,
    };
  },
};
