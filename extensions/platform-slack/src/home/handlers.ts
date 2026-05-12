// Bolt wiring for the App Home tab. Mirrors `events/messages.ts`:
// `registerHomeEvents(app, deps)` registers the `app_home_opened` event and the
// `home:refresh` action, both of which gather data from the injected readers
// and publish a freshly-built view via `client.views.publish`.
//
// The data-gathering is the only impure part; `buildHomeView` stays pure.
// Reader failures and `views.publish` failures are swallowed — Slack is the
// thing we don't control, and a bad event must never crash Bolt's event loop.

import type { App } from '@slack/bolt';
import type { KanbanTicket } from '../blocks/kanban';
import type { SessionSummary } from '../blocks/session';
import type { KanbanReader } from '../commands/kanban';
import type { MemoryReader } from '../commands/memory';
import { extractRecentEntries } from '../commands/memory';
import type { Binding, ChannelMode } from '../config';
import { buildHomeView, HOME_REFRESH_ACTION_ID } from './view';

/** Minimal recent-session shape the home view consumes. The wiring layer
 *  adapts `SessionStore.listSessions` (filtered to this bot) to this surface
 *  so the Slack package never imports `@ethosagent/session-sqlite`. Optional
 *  on `SlackAdapterConfig` — when absent, the "Recent sessions" section shows
 *  a tasteful empty state, the same way `/ethos memory` degrades. */
export interface SessionReader {
  /** Most-recent sessions for this bot, newest first. The implementation
   *  decides the cap; the home view renders whatever it returns. */
  recentSessions(): Promise<SessionSummary[]>;
}

/** Read-only slice of `ChannelOverrideStore` the home view needs. */
interface ChannelModeSource {
  entries(): Array<[string, ChannelMode]>;
}

export interface HomeEventDeps {
  binding: Binding;
  /** The bot's Slack display name, resolved from `auth.test` at startup. */
  displayName: string;
  channelOverrides: ChannelModeSource | undefined;
  session: SessionReader | undefined;
  memory: MemoryReader | undefined;
  kanban: KanbanReader | undefined;
  /** Ethos web UI origin for session deep links. Links render only when set. */
  webUiBaseUrl?: string;
}

/** Number of MEMORY.md entries surfaced in the home tab. */
const MEMORY_SNIPPET_COUNT = 5;

export function registerHomeEvents(app: App, deps: HomeEventDeps): void {
  const publishHome = async (
    client: { views: { publish: (args: unknown) => Promise<unknown> } },
    userId: string,
  ): Promise<void> => {
    try {
      const [sessions, kanbanTickets, memorySnippets] = await Promise.all([
        gatherSessions(deps),
        gatherKanban(deps),
        gatherMemory(deps),
      ]);
      const view = buildHomeView({
        bot: { displayName: deps.displayName, binding: deps.binding },
        sessions,
        kanbanTickets,
        memorySnippets,
        channelModes: deps.channelOverrides?.entries() ?? [],
        webUiBaseUrl: deps.webUiBaseUrl,
      });
      await client.views.publish({ user_id: userId, view });
    } catch {
      // Slack is the one thing we don't control — a publish failure or Bolt
      // API drift must not throw inside the event loop.
    }
  };

  app.event('app_home_opened', async ({ event, client }) => {
    const evt = event as { user?: string; tab?: string };
    // `app_home_opened` also fires for the Messages tab — only the Home tab
    // has a view to publish.
    if (evt.tab && evt.tab !== 'home') return;
    if (!evt.user) return;
    await publishHome(client as never, evt.user);
  });

  app.action(HOME_REFRESH_ACTION_ID, async ({ ack, body, client }) => {
    await ack();
    const userId = (body as { user?: { id?: string } }).user?.id;
    if (!userId) return;
    await publishHome(client as never, userId);
  });
}

/** Gather recent sessions, tolerating a missing or throwing reader. */
async function gatherSessions(deps: HomeEventDeps): Promise<SessionSummary[]> {
  if (!deps.session) return [];
  try {
    return await deps.session.recentSessions();
  } catch {
    return [];
  }
}

/** Gather kanban tickets — only for team bots, tolerating reader failure. */
async function gatherKanban(deps: HomeEventDeps): Promise<KanbanTicket[]> {
  if (deps.binding.type !== 'team' || !deps.kanban) return [];
  try {
    return await deps.kanban.listOpenTickets();
  } catch {
    return [];
  }
}

/** Gather the last N MEMORY.md entries, tolerating reader failure. */
async function gatherMemory(deps: HomeEventDeps): Promise<string[]> {
  if (!deps.memory) return [];
  try {
    const body = await deps.memory.read();
    return extractRecentEntries(body, MEMORY_SNIPPET_COUNT);
  } catch {
    return [];
  }
}
