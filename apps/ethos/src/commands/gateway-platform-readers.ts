// `ethos gateway start` — the Slack App Home session / memory readers and the
// slash allowlist, plus `slackSessionStores`, the one Set every reader opened
// for Slack registers its handle in. gateway.ts re-exports the public names;
// its `closeSlackSessionStores` drains this same Set on shutdown (pinned by
// `__tests__/gateway-session-store-state.test.ts`). The personality-card,
// unfurl, kanban and Telegram readers stay in gateway.ts: archcheck pins their
// `@ethosagent/personalities` / `kanban-store` / `skills` value imports there.

import { type EthosConfig, ethosDir } from '@ethosagent/config';
import type { MemoryContext, SessionStore } from '@ethosagent/types';
import { createSessionStore, fileMemoryUnsupportedReason } from '@ethosagent/wiring';
import { openFileMemory } from '../lib/file-memory';

export type AdapterModuleLoader = <T>(modulePath: string, label: string) => Promise<T | null>;

/**
 * Adapt the personality-scoped MemoryProvider to the narrow
 * `{ read, append }` shape the Slack `/ethos memory` command consumes.
 * Scopes every read/write to `personality:<id>` so each Slack bot sees
 * the MEMORY.md of the personality it's bound to — on the configured backend
 * (the vault under `memory: vault`), via `openFileMemory`. A backend with no
 * file memory (vector) returns undefined, so the command answers "Memory is
 * unavailable for this bot." rather than editing files the agent never reads.
 */
export function createSlackMemoryReader(personalityId: string, config: EthosConfig) {
  if (fileMemoryUnsupportedReason(config)) return undefined;
  const provider = openFileMemory(config, 'tool').provider;
  const ctx: MemoryContext = {
    scopeId: `personality:${personalityId}`,
    sessionId: '',
    sessionKey: '',
    platform: 'slack',
    workingDir: process.cwd(),
  };
  return {
    async read(): Promise<string | null> {
      const entry = await provider.read('MEMORY.md', ctx);
      return entry?.content ?? null;
    },
    async append(text: string): Promise<void> {
      await provider.sync([{ action: 'add', key: 'MEMORY.md', content: text }], ctx);
    },
  };
}

/** How many recent sessions the App Home reader hands the Slack adapter. The
 *  view caps its own list at 5 and renders "+ N more" from the overflow, so a
 *  slightly larger window makes that counter meaningful without unbounded IO. */
const SLACK_RECENT_SESSION_LIMIT = 10;

/**
 * Build the App Home "Recent sessions" reader and the `/sessions/<id>` unfurl
 * reader, both backed by the gateway's `sessions.db`. Mirrors
 * `createSlackMemoryReader`: the Slack package never imports
 * `@ethosagent/session-sqlite`, it just consumes these narrow shapes.
 *
 * The store is opened on first read, not at boot — `buildAdapters` runs in
 * contexts (tests, `--dry-run`-style construction) where touching the session
 * database would be a surprising side effect.
 *
 * `recentSessions` filters on the gateway's own lane-key prefix
 * (`slack:<botKey>:`, each segment URL-encoded — see `buildLaneKey` in
 * `@ethosagent/gateway`), so one workspace's App Home never lists another
 * bot's conversations.
 */
/**
 * Every `sessions.db` handle `createSlackSessionReaders` opened — one per
 * Slack bot, lazily, on the first App Home read. Closed together by the host's
 * shutdown (F06); without that each one left a `-wal`/`-shm` pair behind.
 */
export const slackSessionStores = new Set<{ close(): void }>();

export function createSlackSessionReaders(botKey: string) {
  let store: SessionStore | undefined;
  const sessions = (): SessionStore => {
    if (!store) {
      const opened = createSessionStore({ dataDir: ethosDir() });
      slackSessionStores.add(opened);
      store = opened;
    }
    return store;
  };
  const prefix = `slack:${encodeURIComponent(botKey)}:`;
  return {
    session: {
      async recentSessions() {
        const rows = await sessions().listSessions({
          keyPrefix: prefix,
          limit: SLACK_RECENT_SESSION_LIMIT,
        });
        return rows.map((s) => ({
          id: s.id,
          // The lane key's tail is the channel (plus thread, when threaded) —
          // the only human-meaningful part of an otherwise opaque key.
          label: s.key.slice(prefix.length) || s.key,
          lastActivity: s.updatedAt,
        }));
      },
    },
    sessionUnfurl: {
      async lookupSession(id: string) {
        const s = await sessions().getSession(id);
        if (!s) return null;
        return {
          id: s.id,
          // Sessions store the personality id, which is what operators name
          // their personalities by; no registry lookup buys anything here.
          personalityName: s.personalityId ?? 'unknown',
          lastActivity: s.updatedAt,
        };
      },
    },
  };
}

/**
 * Effective allowlist for a Slack app's out-of-band surfaces — the `/ethos`
 * slash command and the App Home tab. Neither is an inbound message, so the
 * gateway's `checkMessage` never sees them; this is where they get their
 * trust set, and it is derived from the message surface's so the two cannot
 * disagree about who is trusted.
 *
 * Base = `channel_filter.slack` (`ownerUserId` + `recipientAllowlist`), the
 * exact set `checkMessage` admits. `slack.apps.<i>.allowedSlashUsers`, when
 * set, *narrows* that base — it can never widen it, so a user who cannot get
 * a message to the bot can never drive its privileged surfaces either.
 *
 * Fail-closed: no `channel_filter.slack` entry, no allowlisted senders, or an
 * `allowedSlashUsers` list that shares no id with the base, all yield `[]`,
 * and an empty list authorizes nobody. `channel_filter.slack.enabled: false`
 * is deliberately not an escape hatch here — disabling the message filter
 * opens the message surface, not the surfaces that write MEMORY.md and
 * rewrite channel routing.
 */
export function slackSlashAllowlist(
  filter: { ownerUserId?: string; recipientAllowlist?: string[] } | undefined,
  allowedSlashUsers: string[] | undefined,
): string[] {
  const base: string[] = [];
  if (filter?.ownerUserId) base.push(filter.ownerUserId);
  if (filter?.recipientAllowlist) base.push(...filter.recipientAllowlist);
  if (!allowedSlashUsers || allowedSlashUsers.length === 0) return base;
  return base.filter((id) => allowedSlashUsers.includes(id));
}
