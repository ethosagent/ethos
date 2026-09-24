import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { migrate } from '@ethosagent/sqlite';

// ---------------------------------------------------------------------------
// Durable inbound spool — a write-ahead record of turns the gateway owes
//
// `inbound-dedup` records that a message was SEEN, which is the opposite of
// durability: once a message is marked seen, a crash between receipt and turn
// completion loses it, and the platform's own retry is then dropped as a
// duplicate. This store is the durable half of inbound, the way
// `delivery-ledger` is the durable half of outbound:
//
//   1. `accept()` writes a `received` row in the same synchronous span as the
//      dedup check, before any other work.
//   2. The lane task moves it to `processing` (`markProcessing`, which is where
//      an attempt is counted) and to `done` only once the turn has drained AND
//      its answer has joined — by then the reply is either delivered or a
//      `pending` obligation in the delivery ledger.
//   3. On boot the gateway replays every `received` row it owns
//      (`Gateway.replayInboundSpool`, extensions/gateway/src/index.ts).
//
// A separate package from `inbound-dedup` on purpose (plan
// reach-and-containment D2-1): dedup rows expire on a 60-minute TTL and hold
// only a key; a spool row is owed work that never ages out and holds the whole
// message.
//
// Same shape as the other SQLite stores (delivery-ledger, notify-queue,
// outbox): raw `node:fs` only to mkdir -p the database file's parent
// directory, then `@ethosagent/sqlite` opens the path directly. The replay
// claim is a conditional UPDATE inside a transaction, which no Storage
// interface can express.
// ---------------------------------------------------------------------------

/**
 * Lifecycle of one spooled message.
 *
 * - `received` — written before any work; owed.
 * - `processing` — a process is running the turn. Found at boot, it belongs to
 *   a dead process (the gateway singleton lock proves no live peer shares the
 *   file) and `recoverOrphans` returns it to `received`.
 * - `done` — the turn drained and its answer joined, or the message was
 *   consumed without a turn (a slash command, a clarify answer, a safety drop).
 * - `dead` — gave up: `attempts` reached the cap, the row was too old to
 *   replay, or an operator will decide. Never auto-replayed.
 */
export type SpoolStatus = 'received' | 'processing' | 'done' | 'dead';

export interface SpoolAccept {
  platform: string;
  botKey: string;
  chatId: string;
  /** Empty string is normalized to "no thread" — it carries no routing signal. */
  threadId?: string;
  /** The platform id, or a synthesized one (see the gateway's `spoolMessageId`). */
  messageId: string;
  laneKey: string;
  /** JSON-serialized `InboundMessage`. */
  payload: string;
  /**
   * The process that owns the row from the moment it is written, or `null` to
   * leave it for the replay loop to claim. A live message the gateway runs
   * itself is claimed at accept; one that arrives mid-replay is not, so the
   * replay picks it up in lane order behind older rows.
   */
  claimedBy?: string | null;
}

export interface SpoolRow {
  id: string;
  platform: string;
  botKey: string;
  chatId: string;
  threadId?: string;
  messageId: string;
  laneKey: string;
  payload: string;
  status: SpoolStatus;
  attempts: number;
  lastError?: string;
  receivedAt: number;
  updatedAt: number;
  claimedBy?: string;
}

export type SpoolStats = Record<SpoolStatus, number>;

/** Widest window {@link InboundSpool.listDead} will open. */
const MAX_DEAD_LIST = 500;

/**
 * The contract the gateway codes against. Exported from this package rather
 * than `@ethosagent/types`: the gateway takes it as an optional
 * `GatewayConfig.inboundSpool`, the same way it takes `inboundDedup`.
 *
 * Every method is synchronous. `accept` and `markProcessing` run inline on the
 * inbound path — awaiting would reorder it — and `@ethosagent/sqlite` has no
 * async API, so the rest have nothing to await either.
 */
export interface InboundSpool {
  /** `INSERT OR IGNORE` on `(platform, bot_key, chat_id, message_id)`.
   *  `fresh: false` means the key was already spooled; `id` is then that row's. */
  accept(row: SpoolAccept): { id: string; fresh: boolean };
  /** `received` → `processing`, counting one attempt. `false` = not `received`. */
  markProcessing(id: string, owner: string): boolean;
  /** Any non-terminal state → `done`, with the payload nulled. */
  markDone(id: string): void;
  /**
   * A turn failed. `processing` → `dead` when `attempts >= maxAttempts`,
   * otherwise → `received`. Increments nothing: the attempt was counted at
   * `markProcessing`. The claim is KEPT on a `received` outcome, so the same
   * process does not retry in a hot loop; the next boot's `recoverOrphans`
   * releases it.
   */
  markFailed(id: string, error: string, maxAttempts: number): 'received' | 'dead';
  /** `received` (unclaimed) → `dead` with `error` — the stale-replay path. */
  markDead(id: string, error: string): boolean;
  /** Unclaimed `received` rows whose `bot_key` is in `botKeys`, ordered
   *  `lane_key, received_at, rowid`. Empty list in → empty list out. */
  listReplayable(botKeys: readonly string[]): SpoolRow[];
  /** Conditional UPDATE in a transaction: unclaimed `received` → claimed by
   *  `owner`. `false` means another claimant won. */
  claim(id: string, owner: string): boolean;
  /**
   * At boot: every `processing` row, and every `received` row claimed by some
   * OTHER owner, returns to unclaimed `received`. Rows claimed by `owner`
   * itself are this process's live work and are left alone. Returns the number
   * of `processing` rows recovered.
   */
  recoverOrphans(owner: string): number;
  /** Shutdown abort: `processing` → unclaimed `received`, refunding the attempt. */
  releaseOnShutdown(id: string): void;
  /** `dead` rows, newest first. `limit` clamped to 1–500. */
  listDead(limit?: number): SpoolRow[];
  get(id: string): SpoolRow | null;
  /** `dead` → unclaimed `received`, `attempts = 0`. */
  requeue(id: string): boolean;
  /** `dead` → `done`, `last_error = 'discarded'`. */
  discard(id: string): boolean;
  /** Delete `done` rows last updated before `cutoffMs`. Never touches owed rows. */
  pruneDone(cutoffMs: number): number;
  /** Delete `dead` rows last updated before `cutoffMs`. */
  pruneDead(cutoffMs: number): number;
  /** Unclaimed-or-not `received` rows whose `bot_key` is NOT in `botKeys`. */
  listOrphaned(botKeys: readonly string[]): SpoolRow[];
  stats(): SpoolStats;
  close(): void;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS inbound_spool (
    id           TEXT    PRIMARY KEY,
    platform     TEXT    NOT NULL,
    bot_key      TEXT    NOT NULL,
    chat_id      TEXT    NOT NULL,
    -- NULL = root chat, never ''.
    thread_id    TEXT,
    message_id   TEXT    NOT NULL,
    lane_key     TEXT    NOT NULL,
    payload      TEXT    NOT NULL,
    status       TEXT    NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    received_at  INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    claimed_by   TEXT,
    UNIQUE (platform, bot_key, chat_id, message_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS inbound_spool_status ON inbound_spool(status, received_at);
  CREATE INDEX IF NOT EXISTS inbound_spool_lane   ON inbound_spool(lane_key, received_at);
`;

interface Row {
  id: string;
  platform: string;
  bot_key: string;
  chat_id: string;
  thread_id: string | null;
  message_id: string;
  lane_key: string;
  payload: string;
  status: string;
  attempts: number;
  last_error: string | null;
  received_at: number;
  updated_at: number;
  claimed_by: string | null;
}

function toRow(r: Row): SpoolRow {
  return {
    id: r.id,
    platform: r.platform,
    botKey: r.bot_key,
    chatId: r.chat_id,
    ...(r.thread_id ? { threadId: r.thread_id } : {}),
    messageId: r.message_id,
    laneKey: r.lane_key,
    payload: r.payload,
    status: r.status as SpoolStatus,
    attempts: r.attempts,
    ...(r.last_error !== null ? { lastError: r.last_error } : {}),
    receivedAt: r.received_at,
    updatedAt: r.updated_at,
    ...(r.claimed_by !== null ? { claimedBy: r.claimed_by } : {}),
  };
}

function isStatus(v: string): v is SpoolStatus {
  return v === 'received' || v === 'processing' || v === 'done' || v === 'dead';
}

export interface InboundSpoolOptions {
  /** Clock seam, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// SQLiteInboundSpool
// ---------------------------------------------------------------------------

export class SQLiteInboundSpool implements InboundSpool {
  private readonly db: Database.Database;
  private readonly now: () => number;

  constructor(dbPath: string, options: InboundSpoolOptions = {}) {
    // mkdir -p the parent directory — the same raw-fs exception the other
    // SQLite stores use for path setup. `:memory:` has no parent path.
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // The gateway, `ethos doctor`, the `ethos gateway spool` subcommands and
    // web-api's Deliveries page all open this file; wait instead of throwing
    // SQLITE_BUSY.
    this.db.pragma('busy_timeout = 5000');
    // FULL, not NORMAL, and set explicitly rather than inherited: a `received`
    // row is a message the user sent and was never answered, and a power cut
    // rolling it back under NORMAL is the exact loss this store exists to
    // prevent. Pinned by the `durability posture` test in
    // src/__tests__/spool.test.ts.
    this.db.pragma('synchronous = FULL');

    migrate(this.db, {
      name: 'inbound-spool',
      targetVersion: 1,
      baseline: SCHEMA,
      migrations: {},
    });
    this.now = options.now ?? Date.now;
  }

  accept(row: SpoolAccept): { id: string; fresh: boolean } {
    const id = randomUUID();
    const at = this.now();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO inbound_spool
         (id, platform, bot_key, chat_id, thread_id, message_id, lane_key, payload, status,
          attempts, last_error, received_at, updated_at, claimed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', 0, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        row.platform,
        row.botKey,
        row.chatId,
        row.threadId ? row.threadId : null,
        row.messageId,
        row.laneKey,
        row.payload,
        at,
        at,
        row.claimedBy ?? null,
      );
    if (result.changes === 1) return { id, fresh: true };
    const existing = this.db
      .prepare(
        `SELECT id FROM inbound_spool
         WHERE platform = ? AND bot_key = ? AND chat_id = ? AND message_id = ?`,
      )
      .get(row.platform, row.botKey, row.chatId, row.messageId) as { id: string } | undefined;
    return { id: existing?.id ?? id, fresh: false };
  }

  markProcessing(id: string, owner: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE inbound_spool
         SET status = 'processing', attempts = attempts + 1, claimed_by = ?, updated_at = ?
         WHERE id = ? AND status = 'received'`,
      )
      .run(owner, this.now(), id);
    return result.changes === 1;
  }

  markDone(id: string): void {
    // The payload is nulled here, not at prune: the transcript already lives in
    // sessions.db, and a second copy of every message body for the retention
    // window would double the privacy surface. The row stays for the UNIQUE
    // key (it extends dedup's window) and for forensics.
    this.db
      .prepare(
        `UPDATE inbound_spool SET status = 'done', payload = '{}', updated_at = ?
         WHERE id = ? AND status IN ('received', 'processing')`,
      )
      .run(this.now(), id);
  }

  markFailed(id: string, error: string, maxAttempts: number): 'received' | 'dead' {
    const decide = this.db.transaction((): 'received' | 'dead' => {
      const row = this.db.prepare('SELECT attempts FROM inbound_spool WHERE id = ?').get(id) as
        | { attempts: number }
        | undefined;
      const outcome: 'received' | 'dead' = row && row.attempts >= maxAttempts ? 'dead' : 'received';
      this.db
        .prepare(
          `UPDATE inbound_spool SET status = ?, last_error = ?, updated_at = ?
           WHERE id = ? AND status IN ('received', 'processing')`,
        )
        .run(outcome, error, this.now(), id);
      return outcome;
    });
    return decide();
  }

  markDead(id: string, error: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE inbound_spool SET status = 'dead', last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'received' AND claimed_by IS NULL`,
      )
      .run(error, this.now(), id);
    return result.changes === 1;
  }

  listReplayable(botKeys: readonly string[]): SpoolRow[] {
    if (botKeys.length === 0) return [];
    // Ownership filter, as the ledger's `listPending`: a row for a bot this
    // process does not serve is left for whichever process does (or for doctor
    // to report as orphaned). `rowid` is selected-for explicitly by ORDER BY —
    // same-millisecond rows otherwise come back in an arbitrary order.
    const placeholders = botKeys.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM inbound_spool
         WHERE status = 'received' AND claimed_by IS NULL AND bot_key IN (${placeholders})
         ORDER BY lane_key ASC, received_at ASC, rowid ASC`,
      )
      .all(...botKeys) as Row[];
    return rows.map(toRow);
  }

  claim(id: string, owner: string): boolean {
    // The delivery ledger's claim shape: two claimants both see the row in
    // `listReplayable`; only the one whose UPDATE changes a row proceeds.
    const claim = this.db.transaction((): boolean => {
      const result = this.db
        .prepare(
          `UPDATE inbound_spool SET claimed_by = ?, updated_at = ?
           WHERE id = ? AND status = 'received' AND claimed_by IS NULL`,
        )
        .run(owner, this.now(), id);
      return result.changes === 1;
    });
    return claim();
  }

  recoverOrphans(owner: string): number {
    const recover = this.db.transaction((): number => {
      const at = this.now();
      const processing = this.db
        .prepare(
          `UPDATE inbound_spool SET status = 'received', claimed_by = NULL, updated_at = ?
           WHERE status = 'processing' AND (claimed_by IS NULL OR claimed_by != ?)`,
        )
        .run(at, owner);
      this.db
        .prepare(
          `UPDATE inbound_spool SET claimed_by = NULL, updated_at = ?
           WHERE status = 'received' AND claimed_by IS NOT NULL AND claimed_by != ?`,
        )
        .run(at, owner);
      return processing.changes;
    });
    return recover();
  }

  releaseOnShutdown(id: string): void {
    // A turn interrupted by SIGTERM is owed, not failed: the attempt counted at
    // `markProcessing` is refunded. A `kill -9` cannot run this, so a message
    // that crashes the process still burns an attempt per boot — which is what
    // dead-letters a poison message.
    this.db
      .prepare(
        `UPDATE inbound_spool
         SET status = 'received', claimed_by = NULL, updated_at = ?,
             attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END
         WHERE id = ? AND status = 'processing'`,
      )
      .run(this.now(), id);
  }

  listDead(limit = 50): SpoolRow[] {
    const n = Number.isInteger(limit) ? Math.min(MAX_DEAD_LIST, Math.max(1, limit)) : 50;
    const rows = this.db
      .prepare(
        `SELECT * FROM inbound_spool WHERE status = 'dead'
         ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
      )
      .all(n) as Row[];
    return rows.map(toRow);
  }

  get(id: string): SpoolRow | null {
    const row = this.db.prepare('SELECT * FROM inbound_spool WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row ? toRow(row) : null;
  }

  requeue(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE inbound_spool
         SET status = 'received', attempts = 0, claimed_by = NULL, updated_at = ?
         WHERE id = ? AND status = 'dead'`,
      )
      .run(this.now(), id);
    return result.changes === 1;
  }

  discard(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE inbound_spool
         SET status = 'done', last_error = 'discarded', payload = '{}', updated_at = ?
         WHERE id = ? AND status = 'dead'`,
      )
      .run(this.now(), id);
    return result.changes === 1;
  }

  pruneDone(cutoffMs: number): number {
    // `done` only. `received` and `processing` are owed work and are never
    // age-pruned; `dead` has its own, longer window (`pruneDead`).
    return this.db
      .prepare(`DELETE FROM inbound_spool WHERE status = 'done' AND updated_at < ?`)
      .run(cutoffMs).changes;
  }

  pruneDead(cutoffMs: number): number {
    return this.db
      .prepare(`DELETE FROM inbound_spool WHERE status = 'dead' AND updated_at < ?`)
      .run(cutoffMs).changes;
  }

  listOrphaned(botKeys: readonly string[]): SpoolRow[] {
    const filter =
      botKeys.length > 0 ? `AND bot_key NOT IN (${botKeys.map(() => '?').join(', ')})` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM inbound_spool WHERE status = 'received' ${filter}
         ORDER BY received_at ASC, rowid ASC LIMIT ?`,
      )
      .all(...botKeys, MAX_DEAD_LIST) as Row[];
    return rows.map(toRow);
  }

  stats(): SpoolStats {
    const out: SpoolStats = { received: 0, processing: 0, done: 0, dead: 0 };
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM inbound_spool GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    for (const r of rows) if (isStatus(r.status)) out[r.status] = r.n;
    return out;
  }

  /** Oldest `received_at` among `received` rows, or `null` when none. */
  oldestReceivedAt(): number | null {
    const row = this.db
      .prepare(`SELECT MIN(received_at) AS t FROM inbound_spool WHERE status = 'received'`)
      .get() as { t: number | null } | undefined;
    return row?.t ?? null;
  }

  close(): void {
    this.db.close();
  }
}
