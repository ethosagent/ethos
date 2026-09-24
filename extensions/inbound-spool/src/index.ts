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
//   1. `accept()` writes a `received` row before any other work — and before
//      the durable dedup sighting, so a crash between the two leaves a row
//      rather than a lost message (`Gateway.acceptInbound`). Its UNIQUE key is
//      the durable dedup record for everything it holds.
//   2. The lane task moves it to `processing` (`markProcessing`, which is where
//      an attempt is counted) and to `done` only once the turn has drained AND
//      its answer has joined — by then the reply is either delivered or a
//      `pending` obligation in the delivery ledger.
//   3. On boot the gateway replays every `received` row it owns
//      (`Gateway.replayInboundSpool`, extensions/gateway/src/index.ts).
//   4. A turn that had started a tool is NEVER replayed (plan
//      openclaw-9.5-adoption D5): the first `tool_start` stamps
//      `tool_started_at` (`markToolStarted`), and replay, a failure or a
//      shutdown then moves the row to `interrupted` instead of `received`. The
//      user is told, and only their explicit `retry` re-runs it
//      (`retryInterrupted`) — re-running a half-executed payment or file write
//      on their behalf is the one thing this store must not do.
//
// State machine (schema v2):
//
//   accept ─► received ─markProcessing─► processing ─markDone─► done
//               ▲    ▲                      │   │   │
//               │    └── releaseOnShutdown ─┘   │   └─ markToolStarted (tool_started_at)
//               │        markFailed (<cap, no   │
//               │        tool started)          ├─ markFailed at the cap ───────► dead
//               │                               └─ markFailed / markInterrupted,
//               │                                  a tool started ──────────────► interrupted
//   requeue ◄───┴── dead | interrupted  (clears tool_started_at)
//   retryInterrupted: interrupted → done, plus a NEW `received` row, same payload
//   discard:          dead | interrupted → done
//
// Two kinds of row share the table: `inbound` (a platform message) and
// `wake_review` (a background job's result the parent session reviews before
// the user sees it, plan openclaw-9.5-adoption item 6 / D29). The gateway owns
// the kind-specific terminals; the store only records them.
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
 * - `interrupted` — the turn had started a tool when it was cut (crash,
 *   failure or shutdown). Never auto-replayed (D5): it waits for the user's
 *   `retry` (`retryInterrupted`), any other message discards it, and an
 *   operator can requeue or discard it like a dead letter.
 */
export type SpoolStatus = 'received' | 'processing' | 'done' | 'dead' | 'interrupted';

/**
 * - `inbound` — a message a platform delivered.
 * - `wake_review` — a finished `deliver: 'parent'` background job, run as a
 *   review turn on its origin lane. Keyed `wake:<jobId>`, so a second
 *   admission of the same job is the UNIQUE key's no-op.
 */
export type SpoolKind = 'inbound' | 'wake_review';

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
  /** Defaults to `inbound`. */
  kind?: SpoolKind;
  /** The job a `wake_review` row reviews. */
  reviewJobId?: string;
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
  kind: SpoolKind;
  reviewJobId?: string;
  /** When the turn running this row first started a tool. Set → never replayed. */
  toolStartedAt?: number;
}

export type SpoolStats = Record<SpoolStatus, number>;

/** Where {@link InboundSpool.markFailed} left the row. */
export type SpoolFailOutcome = 'received' | 'dead' | 'interrupted';

/** Widest window {@link InboundSpool.listDead} will open. */
const MAX_DEAD_LIST = 500;

/** The `user_version` this code migrates `inbound-spool.db` to. Exported so a
 *  non-migrating writer (`ethos gateway spool`, apps/ethos/src/commands/gateway-status.ts)
 *  can refuse a file at any other version instead of writing into a schema it
 *  does not know. */
export const INBOUND_SPOOL_SCHEMA_VERSION = 2;

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
   * A turn failed. `processing` → `dead` when `attempts >= maxAttempts`;
   * otherwise → `interrupted` when the turn had started a tool (never re-run
   * automatically, D5), else → `received`. Increments nothing: the attempt was
   * counted at `markProcessing`. The claim is KEPT on a `received` outcome, so
   * the same process does not retry in a hot loop; the next boot's
   * `recoverOrphans` releases it.
   */
  markFailed(id: string, error: string, maxAttempts: number): SpoolFailOutcome;
  /** First `tool_start` of the turn running this `processing` row. One commit,
   *  only on turns that use tools; later calls are no-ops. */
  markToolStarted(id: string): void;
  /** `received` | `processing` → `interrupted`, claim released. `false` = the
   *  row was in neither state. */
  markInterrupted(id: string, reason: string): boolean;
  /** The newest `interrupted` row on `laneKey` interrupted at or after
   *  `sinceMs`, or `null`. */
  findInterrupted(laneKey: string, sinceMs: number): SpoolRow | null;
  /**
   * The user replied `retry`: ONE transaction closes the `interrupted` row
   * (`done`) and inserts a fresh `received` row with the same payload, lane and
   * kind, claimed by `owner`, keyed `retry:<old id>`. Returns the new row's id,
   * or `null` when the row is no longer `interrupted` (already retried or
   * discarded) — so two concurrent `retry`s run it once.
   */
  retryInterrupted(id: string, owner: string): string | null;
  /** `interrupted` rows, newest first. `limit` clamped to 1–500. */
  listInterrupted(limit?: number): SpoolRow[];
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
  /** `dead` | `interrupted` → unclaimed `received`, `attempts = 0`, with
   *  `tool_started_at` cleared: an operator requeue IS the explicit decision to
   *  re-run, so the D5 guard must not bounce it straight back. */
  requeue(id: string): boolean;
  /** `dead` | `interrupted` → `done`, `last_error = 'discarded'`. */
  discard(id: string): boolean;
  /** Delete `done` rows last updated before `cutoffMs`. Never touches owed rows. */
  pruneDone(cutoffMs: number): number;
  /** Delete `dead` and `interrupted` rows last updated before `cutoffMs`. */
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
    -- v2 (plan openclaw-9.5-adoption items 2 and 6).
    tool_started_at INTEGER,
    kind         TEXT    NOT NULL DEFAULT 'inbound',
    review_job_id TEXT,
    UNIQUE (platform, bot_key, chat_id, message_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS inbound_spool_status ON inbound_spool(status, received_at);
  CREATE INDEX IF NOT EXISTS inbound_spool_lane   ON inbound_spool(lane_key, received_at);
`;

/**
 * Forward-only steps; the baseline above already describes v2, so a fresh
 * database never runs one. `ADD COLUMN` keeps the table STRICT and leaves every
 * v1 row as `kind = 'inbound'` with no tool start — the honest state for a row
 * written before either existed. The `table_info` guard keeps a step
 * idempotent on a hand-repaired file.
 */
const SPOOL_MIGRATIONS: Record<number, (db: Database.Database) => void> = {
  2: (db) => {
    const cols = new Set(
      (db.pragma('table_info(inbound_spool)') as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('tool_started_at')) {
      db.exec('ALTER TABLE inbound_spool ADD COLUMN tool_started_at INTEGER');
    }
    if (!cols.has('kind')) {
      db.exec(`ALTER TABLE inbound_spool ADD COLUMN kind TEXT NOT NULL DEFAULT 'inbound'`);
    }
    if (!cols.has('review_job_id')) {
      db.exec('ALTER TABLE inbound_spool ADD COLUMN review_job_id TEXT');
    }
  },
};

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
  tool_started_at: number | null;
  kind: string;
  review_job_id: string | null;
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
    kind: r.kind === 'wake_review' ? 'wake_review' : 'inbound',
    ...(r.review_job_id !== null ? { reviewJobId: r.review_job_id } : {}),
    ...(r.tool_started_at !== null ? { toolStartedAt: r.tool_started_at } : {}),
  };
}

function isStatus(v: string): v is SpoolStatus {
  return (
    v === 'received' || v === 'processing' || v === 'done' || v === 'dead' || v === 'interrupted'
  );
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
      targetVersion: INBOUND_SPOOL_SCHEMA_VERSION,
      baseline: SCHEMA,
      migrations: SPOOL_MIGRATIONS,
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
          attempts, last_error, received_at, updated_at, claimed_by, kind, review_job_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', 0, NULL, ?, ?, ?, ?, ?)`,
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
        row.kind ?? 'inbound',
        row.reviewJobId ?? null,
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

  markFailed(id: string, error: string, maxAttempts: number): SpoolFailOutcome {
    const decide = this.db.transaction((): SpoolFailOutcome => {
      const row = this.db
        .prepare('SELECT attempts, tool_started_at FROM inbound_spool WHERE id = ?')
        .get(id) as { attempts: number; tool_started_at: number | null } | undefined;
      let outcome: SpoolFailOutcome = 'received';
      if (row && row.attempts >= maxAttempts) outcome = 'dead';
      else if (row && row.tool_started_at !== null) outcome = 'interrupted';
      // An interrupted row waits on the USER, not on this process, so its claim
      // is released. A `received` one keeps its claim (no hot-loop retry).
      this.db
        .prepare(
          `UPDATE inbound_spool
           SET status = ?, last_error = ?, updated_at = ?,
               claimed_by = CASE WHEN ? = 'interrupted' THEN NULL ELSE claimed_by END
           WHERE id = ? AND status IN ('received', 'processing')`,
        )
        .run(outcome, error, this.now(), outcome, id);
      return outcome;
    });
    return decide();
  }

  markToolStarted(id: string): void {
    const at = this.now();
    this.db
      .prepare(
        `UPDATE inbound_spool SET tool_started_at = ?, updated_at = ?
         WHERE id = ? AND status = 'processing' AND tool_started_at IS NULL`,
      )
      .run(at, at, id);
  }

  markInterrupted(id: string, reason: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE inbound_spool
         SET status = 'interrupted', claimed_by = NULL, last_error = ?, updated_at = ?
         WHERE id = ? AND status IN ('received', 'processing')`,
      )
      .run(reason, this.now(), id);
    return result.changes === 1;
  }

  findInterrupted(laneKey: string, sinceMs: number): SpoolRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM inbound_spool
         WHERE lane_key = ? AND status = 'interrupted' AND updated_at >= ?
         ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
      )
      .get(laneKey, sinceMs) as Row | undefined;
    return row ? toRow(row) : null;
  }

  retryInterrupted(id: string, owner: string): string | null {
    const retry = this.db.transaction((): string | null => {
      const old = this.db
        .prepare(`SELECT * FROM inbound_spool WHERE id = ? AND status = 'interrupted'`)
        .get(id) as Row | undefined;
      if (!old) return null;
      const at = this.now();
      this.db
        .prepare(
          `UPDATE inbound_spool
           SET status = 'done', payload = '{}', last_error = 'retried', updated_at = ?
           WHERE id = ?`,
        )
        .run(at, id);
      const fresh = randomUUID();
      this.db
        .prepare(
          `INSERT INTO inbound_spool
           (id, platform, bot_key, chat_id, thread_id, message_id, lane_key, payload, status,
            attempts, last_error, received_at, updated_at, claimed_by, kind, review_job_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', 0, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          fresh,
          old.platform,
          old.bot_key,
          old.chat_id,
          old.thread_id,
          `retry:${old.id}`,
          old.lane_key,
          old.payload,
          at,
          at,
          owner,
          old.kind,
          old.review_job_id,
        );
      return fresh;
    });
    return retry();
  }

  listInterrupted(limit = 50): SpoolRow[] {
    return readSpoolInterrupted(this.db, limit);
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
    return readSpoolDead(this.db, limit);
  }

  get(id: string): SpoolRow | null {
    return readSpoolRow(this.db, id);
  }

  requeue(id: string): boolean {
    return requeueSpoolDead(this.db, id, this.now());
  }

  discard(id: string): boolean {
    return discardSpoolDead(this.db, id, this.now());
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
      .prepare(
        `DELETE FROM inbound_spool WHERE status IN ('dead', 'interrupted') AND updated_at < ?`,
      )
      .run(cutoffMs).changes;
  }

  listOrphaned(botKeys: readonly string[]): SpoolRow[] {
    return readSpoolOrphaned(this.db, botKeys);
  }

  stats(): SpoolStats {
    return readSpoolStats(this.db);
  }

  /** Oldest `received_at` among `received` rows, or `null` when none. */
  oldestReceivedAt(): number | null {
    return readSpoolOldestReceivedAt(this.db);
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Queries over an already-open handle
//
// The class above opens AND migrates. Diagnostic surfaces (`ethos doctor`,
// `ethos gateway status`) and the operator's `ethos gateway spool` must not
// migrate — a newer binary migrating the file ahead of its gateway is what makes
// `ethos upgrade`'s rollback unsafe (plan openclaw-9.5-adoption D24) — so they
// open the file raw with `@ethosagent/sqlite` and call these. The class
// delegates to the same functions, so there is one copy of each query.
// Pinned by apps/ethos/src/commands/__tests__/diagnostics-never-migrate.test.ts.
// ---------------------------------------------------------------------------

/** Row counts per status. */
export function readSpoolStats(db: Database.Database): SpoolStats {
  const out: SpoolStats = { received: 0, processing: 0, done: 0, dead: 0, interrupted: 0 };
  const rows = db
    .prepare('SELECT status, COUNT(*) AS n FROM inbound_spool GROUP BY status')
    .all() as Array<{ status: string; n: number }>;
  for (const r of rows) if (isStatus(r.status)) out[r.status] = r.n;
  return out;
}

/** Oldest `received_at` among `received` rows, or `null` when none. */
export function readSpoolOldestReceivedAt(db: Database.Database): number | null {
  const row = db
    .prepare(`SELECT MIN(received_at) AS t FROM inbound_spool WHERE status = 'received'`)
    .get() as { t: number | null } | undefined;
  return row?.t ?? null;
}

/** See {@link InboundSpool.listOrphaned}. */
export function readSpoolOrphaned(db: Database.Database, botKeys: readonly string[]): SpoolRow[] {
  const filter =
    botKeys.length > 0 ? `AND bot_key NOT IN (${botKeys.map(() => '?').join(', ')})` : '';
  const rows = db
    .prepare(
      `SELECT * FROM inbound_spool WHERE status = 'received' ${filter}
       ORDER BY received_at ASC, rowid ASC LIMIT ?`,
    )
    .all(...botKeys, MAX_DEAD_LIST) as Row[];
  return rows.map(toRow);
}

/** See {@link InboundSpool.listDead}. */
export function readSpoolDead(db: Database.Database, limit = 50): SpoolRow[] {
  const n = Number.isInteger(limit) ? Math.min(MAX_DEAD_LIST, Math.max(1, limit)) : 50;
  const rows = db
    .prepare(
      `SELECT * FROM inbound_spool WHERE status = 'dead'
       ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
    )
    .all(n) as Row[];
  return rows.map(toRow);
}

/** See {@link InboundSpool.listInterrupted}. */
export function readSpoolInterrupted(db: Database.Database, limit = 50): SpoolRow[] {
  const n = Number.isInteger(limit) ? Math.min(MAX_DEAD_LIST, Math.max(1, limit)) : 50;
  const rows = db
    .prepare(
      `SELECT * FROM inbound_spool WHERE status = 'interrupted'
       ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
    )
    .all(n) as Row[];
  return rows.map(toRow);
}

/** See {@link InboundSpool.get}. */
export function readSpoolRow(db: Database.Database, id: string): SpoolRow | null {
  const row = db.prepare('SELECT * FROM inbound_spool WHERE id = ?').get(id) as Row | undefined;
  return row ? toRow(row) : null;
}

/** See {@link InboundSpool.requeue}. */
export function requeueSpoolDead(db: Database.Database, id: string, now: number): boolean {
  const result = db
    .prepare(
      `UPDATE inbound_spool
       SET status = 'received', attempts = 0, claimed_by = NULL, tool_started_at = NULL,
           updated_at = ?
       WHERE id = ? AND status IN ('dead', 'interrupted')`,
    )
    .run(now, id);
  return result.changes === 1;
}

/** See {@link InboundSpool.discard}. */
export function discardSpoolDead(db: Database.Database, id: string, now: number): boolean {
  const result = db
    .prepare(
      `UPDATE inbound_spool
       SET status = 'done', last_error = 'discarded', payload = '{}', updated_at = ?
       WHERE id = ? AND status IN ('dead', 'interrupted')`,
    )
    .run(now, id);
  return result.changes === 1;
}
