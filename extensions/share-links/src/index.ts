import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { migrate } from '@ethosagent/sqlite';

// ---------------------------------------------------------------------------
// SqliteShareLinkStore — shareable read-only conversation links
// (plan share-links §3). Own file `<dataDir>/share-links.db`.
//
// Guarantees, each pinned by `__tests__/share-link-store.test.ts`:
//   - only sha256(token) is stored, never the token ('stores the sha256 hash,
//     never the token, in any column');
//   - `revoke` / `revokeForSession` / `purgeExpired` null the snapshot in the
//     same transaction that writes the event ('revoke purges the snapshot…',
//     'rolls the snapshot null-out back…');
//   - `findLive` serves nothing revoked or expired ('misses a revoked row',
//     'misses an expired row…');
//   - `share_link_events` is append-only: the store has no mutator for it
//     ('exposes no update or delete method for events');
//   - `synchronous = FULL` so a power cut cannot roll a revoke back
//     ('durability posture'; .claude/rules/sqlite-durability.md).
// ---------------------------------------------------------------------------

type Stmt = ReturnType<Database.Database['prepare']>;

/** Snapshots above this many UTF-8 bytes are refused (plan §10). */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

const TOKEN_BYTES = 32; // 256 bits, base64url -> 43 chars
const PREFIX_LENGTH = 8;

export type ShareLinkEventKind = 'created' | 'revoked' | 'purged';

export class SnapshotTooLargeError extends Error {
  constructor(
    public readonly sizeBytes: number,
    public readonly limitBytes: number = MAX_SNAPSHOT_BYTES,
  ) {
    super(
      `Share snapshot is ${sizeBytes} bytes; the limit is ${limitBytes} bytes (2 MB). Shorten the session or share fewer turns.`,
    );
    this.name = 'SnapshotTooLargeError';
  }
}

export class AmbiguousSharePrefixError extends Error {
  constructor(public readonly prefix: string) {
    super(`Multiple share links match prefix "${prefix}". Use a longer prefix or the full id.`);
    this.name = 'AmbiguousSharePrefixError';
  }
}

/** Shortest token prefix `revoke` accepts; an exact id is always accepted. */
export const MIN_PREFIX_LENGTH = 4;

export class SharePrefixTooShortError extends Error {
  constructor(public readonly prefix: string) {
    super(
      `Share link prefix "${prefix}" is too short; use at least ${MIN_PREFIX_LENGTH} characters or the full id.`,
    );
    this.name = 'SharePrefixTooShortError';
  }
}

export interface CreateShareLinkInput {
  sessionId: string;
  personalityId: string;
  /**
   * The already-redacted snapshot title (`ShareSnapshot.title`), never the raw
   * session title: it stays in the row after revoke or purge null the snapshot.
   */
  title: string;
  /** Opaque JSON text of the include toggles; the store neither parses nor validates it. */
  options: string;
  /** Redacted snapshot JSON, built by the caller. Capped at {@link MAX_SNAPSHOT_BYTES}. */
  snapshot: string;
  expiresAt: Date;
  /** `web:<admin>` or `cli`. Recorded on the `created` event. */
  actor: string;
}

/** A list row: everything except the snapshot body. Timestamps are ISO-8601 UTC. */
export interface ShareLinkSummary {
  id: string;
  /** First 8 chars of the token, kept in cleartext for `ethos sessions share revoke <prefix>`. */
  prefix: string;
  sessionId: string;
  personalityId: string;
  title: string;
  options: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
}

export interface ShareLinkRecord extends ShareLinkSummary {
  /** Null once revoked or purged. */
  snapshot: string | null;
}

export interface CreateShareLinkResult {
  /** Plaintext token. Surface to the operator ONCE, then drop the reference. */
  token: string;
  record: ShareLinkRecord;
}

export interface ShareLinkEvent {
  id: number;
  linkId: string;
  kind: ShareLinkEventKind;
  actor: string;
  at: string;
}

export interface ShareLinkStoreOptions {
  /** Injectable clock for tests. Defaults to `new Date()`. */
  now?: () => Date;
}

/** sha256 hex of a share token — the only form of it that is stored or looked up. */
export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS share_links (
    id             TEXT PRIMARY KEY,
    prefix         TEXT NOT NULL,
    token_hash     TEXT NOT NULL UNIQUE,
    session_id     TEXT NOT NULL,
    personality_id TEXT NOT NULL,
    title          TEXT NOT NULL,
    options        TEXT NOT NULL,
    snapshot       TEXT,
    created_at     TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    revoked_at     TEXT,
    view_count     INTEGER NOT NULL DEFAULT 0,
    last_viewed_at TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_share_links_session ON share_links(session_id);

  CREATE TABLE IF NOT EXISTS share_link_events (
    id      INTEGER PRIMARY KEY,
    link_id TEXT NOT NULL,
    kind    TEXT NOT NULL CHECK (kind IN ('created', 'revoked', 'purged')),
    actor   TEXT NOT NULL,
    at      TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_share_link_events_link ON share_link_events(link_id);
`;

interface LinkRow {
  id: string;
  prefix: string;
  session_id: string;
  personality_id: string;
  title: string;
  options: string;
  snapshot: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
}

interface EventRow {
  id: number;
  link_id: string;
  kind: ShareLinkEventKind;
  actor: string;
  at: string;
}

const SUMMARY_COLUMNS =
  'id, prefix, session_id, personality_id, title, options, created_at, expires_at, revoked_at, view_count, last_viewed_at';

function toSummary(row: Omit<LinkRow, 'snapshot'>): ShareLinkSummary {
  return {
    id: row.id,
    prefix: row.prefix,
    sessionId: row.session_id,
    personalityId: row.personality_id,
    title: row.title,
    options: row.options,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    viewCount: row.view_count,
    lastViewedAt: row.last_viewed_at,
  };
}

function toRecord(row: LinkRow): ShareLinkRecord {
  return { ...toSummary(row), snapshot: row.snapshot };
}

export class SqliteShareLinkStore {
  private readonly db: Database.Database;
  private readonly clock: () => Date;
  // Prepared once; statements are reused across calls and loop iterations.
  private readonly stmts: {
    byId: Stmt;
    livePrefix: Stmt;
    anyPrefix: Stmt;
    revokeRow: Stmt;
    nullSnapshot: Stmt;
    sessionLive: Stmt;
    liveSessions: Stmt;
    expired: Stmt;
    appendEvent: Stmt;
  };

  constructor(dbPath: string, options: ShareLinkStoreOptions = {}) {
    this.clock = options.now ?? (() => new Date());
    // mkdir -p the DB's parent — the same raw-fs exception the other SQLite
    // stores use for path setup (Storage covers ~/.ethos/ data IO, not
    // bootstrapping the DB file's enclosing directory).
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // Explicit, not SQLite's implicit default: a rolled-back revoke reopens a
    // public URL (plan D10). Pinned by the 'durability posture' test.
    this.db.pragma('synchronous = FULL');
    // Shared cross-process (serve + CLI): wait instead of throwing SQLITE_BUSY.
    this.db.pragma('busy_timeout = 5000');
    migrate(this.db, { name: 'share-links', targetVersion: 1, baseline: SCHEMA });
    this.stmts = {
      byId: this.db.prepare('SELECT * FROM share_links WHERE id = ?'),
      livePrefix: this.db.prepare(
        `SELECT * FROM share_links
         WHERE revoked_at IS NULL AND substr(prefix, 1, ?) = ? ORDER BY rowid LIMIT 2`,
      ),
      anyPrefix: this.db.prepare(
        'SELECT * FROM share_links WHERE substr(prefix, 1, ?) = ? ORDER BY rowid DESC LIMIT 1',
      ),
      revokeRow: this.db.prepare(
        'UPDATE share_links SET revoked_at = ?, snapshot = NULL WHERE id = ?',
      ),
      nullSnapshot: this.db.prepare('UPDATE share_links SET snapshot = NULL WHERE id = ?'),
      sessionLive: this.db.prepare(
        `SELECT id FROM share_links
         WHERE session_id = ? AND revoked_at IS NULL AND snapshot IS NOT NULL
         ORDER BY rowid`,
      ),
      liveSessions: this.db.prepare(
        `SELECT DISTINCT session_id FROM share_links
         WHERE revoked_at IS NULL AND snapshot IS NOT NULL ORDER BY session_id`,
      ),
      expired: this.db.prepare(
        `SELECT id FROM share_links
         WHERE snapshot IS NOT NULL AND revoked_at IS NULL AND expires_at <= ?
         ORDER BY rowid`,
      ),
      appendEvent: this.db.prepare(
        'INSERT INTO share_link_events (link_id, kind, actor, at) VALUES (?, ?, ?, ?)',
      ),
    };
  }

  close(): void {
    this.db.close();
  }

  /**
   * Insert a link and its `created` event. Generates the token; the caller gets
   * it back once. Throws {@link SnapshotTooLargeError} above the 2 MB cap.
   */
  create(input: CreateShareLinkInput): CreateShareLinkResult {
    const size = Buffer.byteLength(input.snapshot, 'utf8');
    if (size > MAX_SNAPSHOT_BYTES) throw new SnapshotTooLargeError(size);

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const id = randomUUID();
    const now = this.clock().toISOString();
    const prefix = token.slice(0, PREFIX_LENGTH);

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO share_links
             (id, prefix, token_hash, session_id, personality_id, title, options, snapshot,
              created_at, expires_at, revoked_at, view_count, last_viewed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL)`,
        )
        .run(
          id,
          prefix,
          hashShareToken(token),
          input.sessionId,
          input.personalityId,
          input.title,
          input.options,
          input.snapshot,
          now,
          input.expiresAt.toISOString(),
        );
      this.appendEvent(id, 'created', input.actor, now);
    })();

    return {
      token,
      record: {
        id,
        prefix,
        sessionId: input.sessionId,
        personalityId: input.personalityId,
        title: input.title,
        options: input.options,
        snapshot: input.snapshot,
        createdAt: now,
        expiresAt: input.expiresAt.toISOString(),
        revokedAt: null,
        viewCount: 0,
        lastViewedAt: null,
      },
    };
  }

  /** The row for `tokenHash` if it is not revoked, not expired and still holds a snapshot. */
  findLive(tokenHash: string, now: Date): ShareLinkRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM share_links
         WHERE token_hash = ? AND revoked_at IS NULL AND snapshot IS NOT NULL AND expires_at > ?
         LIMIT 1`,
      )
      .get(tokenHash, now.toISOString()) as LinkRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** Count one view. Views live on the row, not in the event log (plan D13). */
  recordView(id: string, now: Date = this.clock()): void {
    this.db
      .prepare(
        'UPDATE share_links SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?',
      )
      .run(now.toISOString(), id);
  }

  /** Newest first; `rowid` breaks ties at equal timestamps. Never carries snapshots. */
  list(options: { activeOnly: boolean }): ShareLinkSummary[] {
    const where = options.activeOnly
      ? 'WHERE revoked_at IS NULL AND snapshot IS NOT NULL AND expires_at > ?'
      : '';
    const params = options.activeOnly ? [this.clock().toISOString()] : [];
    const rows = this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS} FROM share_links ${where} ORDER BY created_at DESC, rowid DESC`,
      )
      .all(...params) as Array<Omit<LinkRow, 'snapshot'>>;
    return rows.map(toSummary);
  }

  /**
   * Revoke by id or token prefix: sets `revoked_at`, nulls the snapshot and
   * appends a `revoked` event in one transaction. Returns null when nothing
   * matches; revoking an already-revoked link is a no-op that returns it.
   * Throws {@link AmbiguousSharePrefixError} when a prefix matches several live links and
   * {@link SharePrefixTooShortError} for a non-id shorter than {@link MIN_PREFIX_LENGTH}.
   */
  revoke(idOrPrefix: string, actor: string): ShareLinkRecord | null {
    if (idOrPrefix === '') return null;
    const run = this.db.transaction((): ShareLinkRecord | null => {
      const row = this.resolve(idOrPrefix);
      if (!row) return null;
      if (row.revoked_at !== null) return toRecord(row);
      const now = this.clock().toISOString();
      this.revokeRow(row.id, actor, now);
      return toRecord({ ...row, snapshot: null, revoked_at: now });
    });
    return run();
  }

  /** Revoke every live link of a session (session delete). Returns how many. */
  revokeForSession(sessionId: string, actor: string): number {
    const run = this.db.transaction((): number => {
      const rows = this.stmts.sessionLive.all(sessionId) as Array<{ id: string }>;
      const now = this.clock().toISOString();
      for (const { id } of rows) this.revokeRow(id, actor, now);
      return rows.length;
    });
    return run();
  }

  /**
   * Revoke every live link whose session `exists` says is gone (any deletion path: retention,
   * desktop, direct DB). Asks once per distinct session; a throwing `exists` aborts the sweep
   * and revokes nothing further (fail-safe: an unreadable session store never revokes).
   * Each orphan gets a `revoked` event with `actor`, not `purged`: `purged` means expiry
   * (D2), and a link killed because its conversation was deleted is an operator-visible
   * revoke. Returns how many links were revoked.
   */
  async revokeOrphans(
    exists: (sessionId: string) => Promise<boolean>,
    actor: string,
  ): Promise<number> {
    const rows = this.stmts.liveSessions.all() as Array<{ session_id: string }>;
    let revoked = 0;
    for (const { session_id } of rows) {
      if (await exists(session_id)) continue;
      revoked += this.revokeForSession(session_id, actor);
    }
    return revoked;
  }

  /**
   * Null the snapshot of every expired, unrevoked link that still holds one and
   * append a `purged` event for each. Returns how many.
   */
  purgeExpired(now: Date, actor = 'system'): number {
    const run = this.db.transaction((): number => {
      const at = now.toISOString();
      const rows = this.stmts.expired.all(at) as Array<{ id: string }>;
      for (const { id } of rows) {
        this.stmts.nullSnapshot.run(id);
        this.appendEvent(id, 'purged', actor, at);
      }
      return rows.length;
    });
    return run();
  }

  /** Read-only audit trail for one link, oldest first. */
  listEvents(linkId: string): ShareLinkEvent[] {
    const rows = this.db
      .prepare(
        'SELECT id, link_id, kind, actor, at FROM share_link_events WHERE link_id = ? ORDER BY id',
      )
      .all(linkId) as EventRow[];
    return rows.map((r) => ({
      id: r.id,
      linkId: r.link_id,
      kind: r.kind,
      actor: r.actor,
      at: r.at,
    }));
  }

  /**
   * Exact id first. Otherwise a token prefix of at least {@link MIN_PREFIX_LENGTH}
   * chars: ambiguity counts only live (unrevoked) rows, so a revoked twin never
   * blocks revoking the live link. With no live match, the newest revoked match
   * is returned so revoking again stays an idempotent no-op.
   */
  private resolve(idOrPrefix: string): LinkRow | null {
    const byId = this.stmts.byId.get(idOrPrefix) as LinkRow | undefined;
    if (byId) return byId;
    if (idOrPrefix.length < MIN_PREFIX_LENGTH) throw new SharePrefixTooShortError(idOrPrefix);
    const live = this.stmts.livePrefix.all(idOrPrefix.length, idOrPrefix) as LinkRow[];
    if (live.length > 1) throw new AmbiguousSharePrefixError(idOrPrefix);
    if (live[0]) return live[0];
    return (this.stmts.anyPrefix.get(idOrPrefix.length, idOrPrefix) as LinkRow | undefined) ?? null;
  }

  /** Caller must hold a transaction. */
  private revokeRow(id: string, actor: string, at: string): void {
    this.stmts.revokeRow.run(at, id);
    this.appendEvent(id, 'revoked', actor, at);
  }

  private appendEvent(linkId: string, kind: ShareLinkEventKind, actor: string, at: string): void {
    this.stmts.appendEvent.run(linkId, kind, actor, at);
  }
}
