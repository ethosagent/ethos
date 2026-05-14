import { divider, header, type SlackBlock, section } from './shared';

/** Minimal kanban-ticket shape consumed by the Slack adapter. The kanban
 *  store extension is a sibling; we deliberately avoid importing it to
 *  keep this package's deps tight. The adapter consumer (wiring) supplies
 *  a `KanbanReader` whose `listTasks` returns this shape. */
export interface KanbanTicket {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
}

export function kanbanListBlocks(input: { team: string; tickets: KanbanTicket[] }): SlackBlock[] {
  if (input.tickets.length === 0) {
    return [header(`Kanban · ${input.team}`), section('No open tickets.')];
  }
  const blocks: SlackBlock[] = [
    header(`Kanban · ${input.team}`),
    section(`${input.tickets.length} open ticket${input.tickets.length === 1 ? '' : 's'}:`),
    divider(),
  ];
  for (const t of input.tickets) {
    const assignee = t.assignee ? `*Assignee* ${t.assignee}` : '_unassigned_';
    blocks.push(section(`*${t.title}* · status \`${t.status}\` · ${assignee}\n_id_ \`${t.id}\``));
  }
  return blocks;
}

export function kanbanUnavailableBlocks(reason: string): SlackBlock[] {
  return [section(`Kanban is unavailable: ${reason}`)];
}
