// Pure builder for the App Home tab. `(data) => View` — no Slack client, no
// I/O. The handler in `home/handlers.ts` gathers the data from the injected
// readers and publishes the result via `client.views.publish`.
//
// Sections, top to bottom:
//   - Header        — bot identity: display name, binding, status.
//   - Recent sessions — last N sessions, optionally deep-linked to the web UI.
//   - Active kanban — recently active tickets (team-bound bots only).
//   - Recent memory updates — last N MEMORY.md entries (bound personality).
//   - This bot is in — channels the bot is in + their channel mode, + Refresh.

import { type KanbanTicket, kanbanListBlocks } from '../blocks/kanban';
import { type SessionSummary, sessionListBlocks } from '../blocks/session';
import { context, divider, escapeMrkdwn, header, type SlackBlock, section } from '../blocks/shared';
import type { Binding, ChannelMode } from '../config';

/** `action_id` for the home tab's Refresh button. */
export const HOME_REFRESH_ACTION_ID = 'home:refresh';

// Per-section caps. Slack Home tab views have a hard 100-block limit; an
// unbounded reader (a bot in many channels, a busy team) would otherwise emit
// an invalid view. The caps are enforced here in the view builder, independent
// of what the readers return. Sessions/memory match the Phase 3 spec ("last 5
// sessions", "last 5 memory entries"); kanban/channels pick a sensible bound.
const SESSION_CAP = 5;
const MEMORY_CAP = 5;
const KANBAN_CAP = 10;
const CHANNEL_CAP = 20;

/** Truncate `items` to `cap`. Returns the kept slice and the overflow count
 *  so the caller can append an honest `+ N more` context row. */
function capSection<T>(items: T[], cap: number): { kept: T[]; overflow: number } {
  if (items.length <= cap) return { kept: items, overflow: 0 };
  return { kept: items.slice(0, cap), overflow: items.length - cap };
}

/** A Slack `view` payload — the shape `client.views.publish` expects. We use a
 *  minimal structural type for the same reason `blocks/` uses `SlackBlock`:
 *  this package doesn't take a direct `@slack/types` dependency. */
export interface SlackHomeView {
  type: 'home';
  blocks: SlackBlock[];
}

export interface HomeViewInput {
  bot: {
    /** The bot's Slack display name (from `auth.test`), or a fallback. */
    displayName: string;
    binding: Binding;
  };
  /** Recent sessions for this bot. Empty when the reader isn't wired. */
  sessions: SessionSummary[];
  /** Recently active kanban tickets. Empty when not a team bot / not wired. */
  kanbanTickets: KanbanTicket[];
  /** Last N MEMORY.md entries. Empty when the reader isn't wired. */
  memorySnippets: string[];
  /** Channels the bot is in, with their current mode. */
  channelModes: Array<[string, ChannelMode]>;
  /** Ethos web UI origin (no trailing slash) for session deep links. */
  webUiBaseUrl?: string;
}

export function buildHomeView(input: HomeViewInput): SlackHomeView {
  const blocks: SlackBlock[] = [];

  // Header — bot identity.
  blocks.push(header(input.bot.displayName));
  const subject = input.bot.binding.type === 'team' ? 'team' : 'personality';
  blocks.push(
    section(
      `Bound to the *${subject}* \`${escapeMrkdwn(input.bot.binding.name)}\` · status *online*`,
    ),
  );
  blocks.push(divider());

  // Recent sessions.
  const sessions = capSection(input.sessions, SESSION_CAP);
  blocks.push(...sessionListBlocks({ sessions: sessions.kept, webUiBaseUrl: input.webUiBaseUrl }));
  if (sessions.overflow > 0) blocks.push(context([`+ ${sessions.overflow} more`]));

  // Active kanban — team-bound bots only. Hidden entirely for personality bots
  // per the spec (kanban is a team feature).
  if (input.bot.binding.type === 'team') {
    const kanban = capSection(input.kanbanTickets, KANBAN_CAP);
    blocks.push(...kanbanListBlocks({ team: input.bot.binding.name, tickets: kanban.kept }));
    if (kanban.overflow > 0) blocks.push(context([`+ ${kanban.overflow} more`]));
    blocks.push(divider());
  }

  // Recent memory updates.
  blocks.push(header('Recent memory updates'));
  const memory = capSection(input.memorySnippets, MEMORY_CAP);
  if (memory.kept.length === 0) {
    blocks.push(section('No recent memory updates.'));
  } else {
    for (const snippet of memory.kept) {
      blocks.push(section(escapeMrkdwn(snippet)));
    }
    if (memory.overflow > 0) blocks.push(context([`+ ${memory.overflow} more`]));
  }
  blocks.push(divider());

  // This bot is in — channels + their mode.
  blocks.push(header('This bot is in'));
  const channels = capSection(input.channelModes, CHANNEL_CAP);
  if (channels.kept.length === 0) {
    blocks.push(section('This bot is not in any channels yet, or channel state is not persisted.'));
  } else {
    for (const [channel, mode] of channels.kept) {
      blocks.push(section(`<#${escapeMrkdwn(channel)}> · mode \`${mode}\``));
    }
    if (channels.overflow > 0) blocks.push(context([`+ ${channels.overflow} more`]));
  }
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: HOME_REFRESH_ACTION_ID,
        text: { type: 'plain_text', text: 'Refresh', emoji: true },
      },
    ],
  });

  return { type: 'home', blocks };
}
