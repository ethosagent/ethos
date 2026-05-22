// Pure Block Kit builders for `link_shared` URL unfurls — one per Ethos web UI
// URL type (session / kanban / personality). `(data) => SlackBlock[]`,
// no I/O, no Slack-client dependency, like every other `blocks/` module.
//
// Each builder's input is already-resolved data: the `events/links.ts` registrar
// does the lookup and only calls a builder once it has real data, so there is no
// empty-state branch here — an unfurl is all-or-nothing per URL (a blank unfurl
// card is worse than no card). Every model/config/user-influenced field is run
// through `escapeMrkdwn` (these land on a privileged Ethos surface) and capped
// with `truncate` so a single oversized field can't push a `section` past
// Slack's ~3000-char-per-block limit.

import { context, escapeMrkdwn, header, type SlackBlock, section, truncate } from './shared';

/** Per-field caps. Generous, but well under Slack's ~3000-char section limit
 *  even when several capped fields share one block. */
const ID_MAX = 200;
const NAME_MAX = 200;
const TITLE_MAX = 300;
const STATUS_MAX = 80;
const ASSIGNEE_MAX = 120;
const GOAL_MAX = 300;
const DESCRIPTION_MAX = 600;
const SCOPE_MAX = 200;

function clean(text: string, max: number): string {
  return escapeMrkdwn(truncate(text, max));
}

export interface SessionUnfurlData {
  /** Session id — the `/sessions/<id>` path segment. */
  id: string;
  /** Display name of the personality the session ran under. */
  personalityName: string;
  /** Last-activity timestamp. */
  lastActivity: Date;
}

export function sessionUnfurlBlocks(data: SessionUnfurlData): SlackBlock[] {
  return [
    header('Ethos session'),
    section(
      `Session \`${clean(data.id, ID_MAX)}\` · personality *${clean(data.personalityName, NAME_MAX)}*`,
    ),
    context([`Last activity ${data.lastActivity.toISOString()}`]),
  ];
}

export interface KanbanUnfurlData {
  /** Ticket id — the `/kanban/<ticket>` path segment. */
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  /** The parent goal this ticket rolls up to, when there is one. */
  parentGoal: string | null;
}

export function kanbanUnfurlBlocks(data: KanbanUnfurlData): SlackBlock[] {
  const assignee = data.assignee ? clean(data.assignee, ASSIGNEE_MAX) : '_unassigned_';
  const blocks: SlackBlock[] = [
    header('Ethos kanban ticket'),
    section(
      `*${clean(data.title, TITLE_MAX)}* · status \`${clean(data.status, STATUS_MAX)}\` · ${assignee}`,
    ),
  ];
  if (data.parentGoal) {
    blocks.push(context([`Parent goal: ${clean(data.parentGoal, GOAL_MAX)}`]));
  }
  return blocks;
}

export interface PersonalityUnfurlData {
  /** Personality id — the `/personalities/<id>` path segment. */
  id: string;
  name: string;
  description: string;
}

export function personalityUnfurlBlocks(data: PersonalityUnfurlData): SlackBlock[] {
  return [
    header('Ethos personality'),
    section(`*${clean(data.name, NAME_MAX)}*\n${clean(data.description, DESCRIPTION_MAX)}`),
    context([`Memory scope: \`personality:${clean(data.id, SCOPE_MAX)}\``]),
  ];
}
