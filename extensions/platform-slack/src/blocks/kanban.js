import { divider, escapeMrkdwn, header, section } from './shared';
export function kanbanListBlocks(input) {
    if (input.tickets.length === 0) {
        return [header(`Kanban · ${input.team}`), section('No open tickets.')];
    }
    const blocks = [
        header(`Kanban · ${input.team}`),
        section(`${input.tickets.length} open ticket${input.tickets.length === 1 ? '' : 's'}:`),
        divider(),
    ];
    for (const t of input.tickets) {
        const title = escapeMrkdwn(t.title);
        const status = escapeMrkdwn(t.status);
        const id = escapeMrkdwn(t.id);
        const assignee = t.assignee ? `*Assignee* ${escapeMrkdwn(t.assignee)}` : '_unassigned_';
        blocks.push(section(`*${title}* · status \`${status}\` · ${assignee}\n_id_ \`${id}\``));
    }
    return blocks;
}
export function kanbanUnavailableBlocks(reason) {
    return [section(`Kanban is unavailable: ${reason}`)];
}
