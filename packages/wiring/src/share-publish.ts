// The one place share-link refusals, snapshot build and publish live (plan share-links §3, D2,
// D4, D7, D9, D11, D15, §10). apps/web-api (ShareService) and apps/ethos (CLI) both call it, so
// the two surfaces cannot drift. Guarantees, each pinned by
// packages/wiring/src/__tests__/share-publish.test.ts:
// - refusals are a typed result (`reason`), never thrown: disabled, not_found, shared_session
//   (isSharedSession; covers incognito, which is stamped roomAudience 'shared'),
//   excluded_personality, too_large (limit named), empty (zero surviving turns);
// - `previewShare` returns the snapshot `publishShare` stores, byte for byte (D15);
// - the stored row title is the redacted snapshot title;
// - the token appears only in the returned url; the base comes from webBaseUrl or the bind
//   address, never a request Host header.

import { isSharedSession } from '@ethosagent/core';
import { MAX_SNAPSHOT_BYTES, type SqliteShareLinkStore } from '@ethosagent/share-links';
import type { Session } from '@ethosagent/types';
import {
  buildShareSnapshot,
  type ShareSnapshot,
  type ShareSnapshotMessage,
  shareSnapshotBytes,
} from './share-snapshot';

export type ShareExpiry = '1h' | '1d' | '7d' | '30d';

const EXPIRY_MS: Record<ShareExpiry, number> = {
  '1h': 3_600_000,
  '1d': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

export interface ShareBaseUrl {
  url: string;
  loopback: boolean;
}

export interface SharePublishDeps {
  store: Pick<SqliteShareLinkStore, 'create'>;
  /** `resolveShareLinks(config)` from @ethosagent/config. */
  shareLinks: { enabled: boolean; excludePersonalities: readonly string[] };
  /** The read half of SessionStore. */
  sessions: {
    getSession(id: string): Promise<Session | null>;
    getMessages(sessionId: string): Promise<ReadonlyArray<ShareSnapshotMessage>>;
  };
  now: () => Date;
}

export interface SharePublishInput {
  sessionId: string;
  expiresIn: ShareExpiry;
  includeToolNames: boolean;
  pii: boolean;
  /** `web:<admin>` or `cli` (D13). */
  actor: string;
  baseUrl: ShareBaseUrl;
}

export type ShareRefusal =
  | { ok: false; reason: 'disabled' }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'shared_session' }
  | { ok: false; reason: 'excluded_personality'; personalityId: string }
  | { ok: false; reason: 'too_large'; limitBytes: number }
  | { ok: false; reason: 'empty' };

export type SharePreviewResult = { ok: true; snapshot: ShareSnapshot } | ShareRefusal;

export type SharePublishResult =
  | { ok: true; url: string; prefix: string; expiresAt: string; loopback: boolean }
  | ShareRefusal;

type Built = { ok: true; snapshot: ShareSnapshot; session: Session } | ShareRefusal;

async function build(
  deps: SharePublishDeps,
  input: Pick<SharePublishInput, 'sessionId' | 'includeToolNames' | 'pii'>,
): Promise<Built> {
  if (!deps.shareLinks.enabled) return { ok: false, reason: 'disabled' };
  const session = await deps.sessions.getSession(input.sessionId);
  if (!session) return { ok: false, reason: 'not_found' };
  if (isSharedSession(session)) return { ok: false, reason: 'shared_session' };
  if (
    session.personalityId &&
    deps.shareLinks.excludePersonalities.includes(session.personalityId)
  ) {
    return { ok: false, reason: 'excluded_personality', personalityId: session.personalityId };
  }
  const messages = await deps.sessions.getMessages(session.id);
  const snapshot = buildShareSnapshot(session, messages, {
    includeToolNames: input.includeToolNames,
    pii: input.pii,
    createdAt: deps.now().toISOString(),
  });
  // A link to a blank page is an operator mistake (wrong session), not something to publish.
  if (snapshot.turns.length === 0) return { ok: false, reason: 'empty' };
  if (shareSnapshotBytes(snapshot) > MAX_SNAPSHOT_BYTES) {
    return { ok: false, reason: 'too_large', limitBytes: MAX_SNAPSHOT_BYTES };
  }
  return { ok: true, snapshot, session };
}

/** The redacted snapshot exactly as `publishShare` would store it (D15). Writes nothing. */
export async function previewShare(
  deps: SharePublishDeps,
  input: Omit<SharePublishInput, 'actor' | 'baseUrl' | 'expiresIn'>,
): Promise<SharePreviewResult> {
  const built = await build(deps, input);
  return built.ok ? { ok: true, snapshot: built.snapshot } : built;
}

export async function publishShare(
  deps: SharePublishDeps,
  input: SharePublishInput,
): Promise<SharePublishResult> {
  const built = await build(deps, input);
  if (!built.ok) return built;
  const expiresAt = new Date(deps.now().getTime() + EXPIRY_MS[input.expiresIn]);
  const { token, record } = deps.store.create({
    sessionId: built.session.id,
    // The store column is NOT NULL; a session never bound to a personality stores ''.
    personalityId: built.session.personalityId ?? '',
    title: built.snapshot.title,
    options: JSON.stringify({
      expiresIn: input.expiresIn,
      includeToolNames: input.includeToolNames,
      pii: input.pii,
    }),
    snapshot: JSON.stringify(built.snapshot),
    expiresAt,
    actor: input.actor,
  });
  return {
    ok: true,
    url: `${input.baseUrl.url}/share/${token}`,
    prefix: record.prefix,
    expiresAt: record.expiresAt,
    loopback: input.baseUrl.loopback,
  };
}

// Loopback = localhost, ::1 and all of 127.0.0.0/8. Same intent as apps/ethos/src/commands/
// serve-listen.ts `isLoopbackHost` (app-local; wiring cannot import apps). Pinned by the
// loopback cases in __tests__/share-publish.test.ts.
function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * The base URL a share link is printed under: `webBaseUrl` when set, else the bind address.
 * Never derived from a request Host header (plan §4 host-header row). A wildcard bind
 * (`0.0.0.0`, `::`) names no reachable host, so it prints as `localhost` with the loopback
 * warning and the operator is pointed at `webBaseUrl` (D4). Pinned by share-publish.test.ts.
 */
export function resolveShareBaseUrl(opts: {
  webBaseUrl?: string;
  bindHost: string;
  port: number;
}): ShareBaseUrl {
  const configured = opts.webBaseUrl?.trim().replace(/\/+$/, '');
  if (configured) {
    let host = '';
    try {
      host = new URL(configured).hostname.replace(/^\[|\]$/g, '');
    } catch {
      host = '';
    }
    return { url: configured, loopback: isLoopbackHost(host) };
  }
  const bare = opts.bindHost.replace(/^\[|\]$/g, '');
  const bindHost = bare === '0.0.0.0' || bare === '::' ? 'localhost' : bare;
  const host = bindHost.includes(':') ? `[${bindHost}]` : bindHost;
  return { url: `http://${host}:${opts.port}`, loopback: isLoopbackHost(bindHost) };
}
