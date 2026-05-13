// Bolt wiring for `link_shared` — when an Ethos web UI URL is pasted into
// Slack, we unfurl it into a rich Block Kit card. Mirrors `events/messages.ts`
// and `home/handlers.ts`: `registerLinkEvents(app, deps)` registers the event,
// gathers data from the injected lookup readers, and calls `chat.unfurl`.
//
// `matchEthosUrl` is the pure, testable core: it answers "is this shared URL
// under our configured web UI base, and what does its path point to?". Matching
// strictly against the configured origin is also the cross-workspace guard —
// we never fetch data for a URL that isn't under our own base, so an unfurl can
// never leak one workspace's session/ticket/personality into another.
//
// An unfurl is all-or-nothing per URL: when a needed reader is unwired or the
// id isn't found, that URL is skipped entirely rather than rendered as a hollow
// card. Reader failures and `chat.unfurl` failures are swallowed — Slack and the
// readers are things we don't control, and a bad event must never crash Bolt's
// event loop.

import type { App } from '@slack/bolt';
import type { SlackBlock } from '../blocks/shared';
import {
  type KanbanUnfurlData,
  kanbanUnfurlBlocks,
  memoryUnfurlBlocks,
  type PersonalityUnfurlData,
  personalityUnfurlBlocks,
  type SessionUnfurlData,
  sessionUnfurlBlocks,
} from '../blocks/unfurl';
import type { MemoryReader } from '../commands/memory';
import { extractRecentEntries } from '../commands/memory';

/** Lookup-by-id readers the unfurl handler needs. A `link_shared` URL carries a
 *  specific id, so unlike the list-oriented readers used by `/ethos` commands
 *  and the App Home tab, these are point lookups. All optional and injected by
 *  the wiring layer — the Slack package never imports the sibling extensions.
 *  A lookup returns `null` when the id doesn't exist; the handler then skips
 *  that URL rather than posting an empty card. */
export interface SessionUnfurlReader {
  lookupSession(id: string): Promise<SessionUnfurlData | null>;
}
export interface KanbanUnfurlReader {
  lookupTicket(id: string): Promise<KanbanUnfurlData | null>;
}
export interface PersonalityUnfurlReader {
  lookupPersonality(id: string): Promise<PersonalityUnfurlData | null>;
}

export interface LinkEventDeps {
  /** Ethos web UI origin (already normalized — canonicalized, no trailing
   *  slash). When absent, the adapter can't recognize Ethos URLs and the
   *  `link_shared` handler is never registered. */
  webUiBaseUrl?: string;
  session?: SessionUnfurlReader;
  kanban?: KanbanUnfurlReader;
  personality?: PersonalityUnfurlReader;
  /** Reused from the `/ethos memory` command — the memory page unfurl shows a
   *  snippet of recent `MEMORY.md` entries. */
  memory?: MemoryReader;
  /** Memory scope label (the bound personality/team name) shown on the memory
   *  unfurl card. Supplied alongside `memory`; without it the memory URL is
   *  skipped. */
  memoryScope?: string;
}

/** The one Bolt `client` capability the link handler uses. Narrowed at the call
 *  site for the same reason `home/handlers.ts` narrows `views.publish` — keep
 *  the single method type-checked without a direct `@slack/web-api` dependency.
 *  `chat.unfurl` takes a `unfurls` map keyed by the shared URL. */
type LinkClient = {
  chat: {
    unfurl: (args: {
      channel: string;
      ts: string;
      unfurls: Record<string, { blocks: SlackBlock[] }>;
    }) => Promise<unknown>;
  };
};

/** A recognized Ethos web UI URL. `memory` is the only id-less variant — the
 *  memory page is a single scope-bound view, not an id-addressed resource. */
export type EthosUrlMatch =
  | { kind: 'session'; id: string }
  | { kind: 'kanban'; id: string }
  | { kind: 'personality'; id: string }
  | { kind: 'memory' };

/**
 * Match a shared URL against the configured Ethos web UI base. Returns the
 * recognized resource, or `null` when the URL is malformed, on a different
 * origin, outside the base path, or on an unrecognized path. Strict by design:
 * only URLs whose origin AND path-prefix equal the configured base are
 * matched, which is what keeps one workspace's bot from unfurling another
 * workspace's links.
 */
export function matchEthosUrl(
  sharedUrl: string,
  webUiBaseUrl: string | undefined,
): EthosUrlMatch | null {
  if (!webUiBaseUrl) return null;
  let base: URL;
  let url: URL;
  try {
    base = new URL(webUiBaseUrl);
    url = new URL(sharedUrl);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;

  // Strip the base's path prefix so path-prefixed deployments
  // (`https://host/app`) work — the resource path is whatever follows it.
  const basePath = base.pathname.replace(/\/+$/, '');
  if (!url.pathname.startsWith(basePath)) return null;
  const rest = url.pathname.slice(basePath.length);

  const segments = rest.split('/').filter((s) => s.length > 0);

  if (segments.length === 1 && segments[0] === 'memory') {
    return { kind: 'memory' };
  }
  if (segments.length === 2) {
    const [collection, rawId] = segments;
    const id = decodeURIComponent(rawId);
    if (collection === 'sessions') return { kind: 'session', id };
    if (collection === 'kanban') return { kind: 'kanban', id };
    if (collection === 'personalities') return { kind: 'personality', id };
  }
  return null;
}

export function registerLinkEvents(app: App, deps: LinkEventDeps): void {
  // No configured web UI base → we can't recognize any Ethos URL, so there is
  // nothing for the handler to do. Don't register it at all.
  if (!deps.webUiBaseUrl) return;

  app.event('link_shared', async ({ event, client }) => {
    const evt = event as {
      channel?: string;
      message_ts?: string;
      links?: Array<{ url?: string }>;
    };
    if (!evt.channel || !evt.message_ts || !evt.links) return;

    const unfurls: Record<string, { blocks: SlackBlock[] }> = {};
    for (const link of evt.links) {
      const url = link.url;
      if (!url) continue;
      const match = matchEthosUrl(url, deps.webUiBaseUrl);
      if (!match) continue;
      // An unfurl is all-or-nothing: only add a URL once we have real data.
      const blocks = await buildUnfurl(match, deps);
      if (blocks) unfurls[url] = { blocks };
    }

    if (Object.keys(unfurls).length === 0) return;
    try {
      await (client as LinkClient).chat.unfurl({
        channel: evt.channel,
        ts: evt.message_ts,
        unfurls,
      });
    } catch {
      // Slack is the one thing we don't control — a `chat.unfurl` failure or
      // Bolt API drift must not throw inside the event loop.
    }
  });
}

/** Resolve one matched URL to its unfurl blocks, or `null` when the backing
 *  reader is unwired, the id isn't found, or the reader throws. */
async function buildUnfurl(
  match: EthosUrlMatch,
  deps: LinkEventDeps,
): Promise<SlackBlock[] | null> {
  try {
    switch (match.kind) {
      case 'session': {
        if (!deps.session) return null;
        const data = await deps.session.lookupSession(match.id);
        return data ? sessionUnfurlBlocks(data) : null;
      }
      case 'kanban': {
        if (!deps.kanban) return null;
        const data = await deps.kanban.lookupTicket(match.id);
        return data ? kanbanUnfurlBlocks(data) : null;
      }
      case 'personality': {
        if (!deps.personality) return null;
        const data = await deps.personality.lookupPersonality(match.id);
        return data ? personalityUnfurlBlocks(data) : null;
      }
      case 'memory': {
        if (!deps.memory || !deps.memoryScope) return null;
        const body = await deps.memory.read();
        const entries = extractRecentEntries(body, 3);
        if (entries.length === 0) return null;
        return memoryUnfurlBlocks({ scope: deps.memoryScope, entries });
      }
    }
  } catch {
    // A reader failure for one URL must not crash the whole event.
    return null;
  }
}
