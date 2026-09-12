import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { migrate } from '@ethosagent/sqlite';
import { computeContentHash } from './hash';

// ---------------------------------------------------------------------------
// The personality approval outbox — durable store
//
// A gated `send_message` does not send. It proposes: one row here, and a tool
// result that says "Queued for approval … NOT sent". A human approves exactly
// one revision of one text to one destination, and only then does the gateway
// dispatcher claim the row and hand it to `sendTracked`.
//
// Why a store and not a tool approval (O-D1): the in-memory approval stores
// auto-deny after 10 minutes, deny everything pending on shutdown, and hold the
// agent's turn open for the whole wait. A publication has to survive a restart
// and hours of waiting, and one approval must cover exactly one send rather
// than becoming a standing `any-args` permission.
//
// Every state change here is a CONDITIONAL `UPDATE … WHERE`, and the affected-
// row count IS the answer — "did this approval still match what the approver
// saw", "did this process win the claim". That is why the package takes the
// raw-`node:fs` carve-out alongside delivery-ledger and notify-queue (see
// CLAUDE.md): a read-then-write through any `Storage` interface is the exact
// race these statements exist to close.
//
// `synchronous = FULL` (SQLite's default, pinned by a `durability posture`
// test): a pending publication is work owed to a person, and a lost approve
// silently drops it.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fixed windows (O-D11) — module constants, deliberately NOT config keys.
// An approval for a time-sensitive post must not go out three days later
// because the gateway happened to be down.
// ---------------------------------------------------------------------------

/** An item still awaiting a human this long after it was proposed expires. */
export const PENDING_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** An approved item nobody delivered within this window expires. */
export const APPROVAL_VALIDITY_MS = 24 * 60 * 60 * 1000;

/**
 * How long an `awaiting_review` or `sending` row may sit before the dispatcher
 * treats the process that owned it as gone: the reviewer gets an "unavailable"
 * receipt, and a claimed row is reconciled against the delivery ledger.
 */
export const STALE_THRESHOLD_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * Lifecycle of one publication. The item row carries the current state;
 * revisions are immutable.
 *
 * ```
 * propose ─► awaiting_review ─(receipt | stale: "unavailable")─► awaiting_approval
 * propose ─► awaiting_approval                     (no approver_personality)
 * awaiting_approval ─approve(rev,hash)─► approved ─claim─► sending ─► sent | unconfirmed | failed
 * awaiting_approval ─edit─► awaiting_approval      (revision+1, prior approval void)
 * awaiting_approval ─reject(reason)─► rejected     awaiting_* older than 7d ─► expired
 * approved ─revoke─► awaiting_approval             approved not claimed within 24h ─► expired
 * sending ─(pre-send refusal)─► approved           failed ─retry─► approved (same rev)
 * ```
 *
 * `unconfirmed` means the item reached the delivery ledger but the platform did
 * not confirm. From there the LEDGER owns the retry (`sweepPendingDeliveries`)
 * and the item keeps the obligation id. The outbox never resends an item
 * itself — an automatic resend on top of a ledger that is already redelivering
 * is how one approval becomes two posts.
 */
export type OutboxState =
  | 'awaiting_review'
  | 'awaiting_approval'
  | 'approved'
  | 'sending'
  | 'sent'
  | 'unconfirmed'
  | 'failed'
  | 'rejected'
  | 'expired';

/**
 * States an item can still move out of on its own.
 *
 * `failed` is in the list because `retry` exists: a failed item is a
 * publication the human still has to decide about, so a repeat proposal of the
 * same text must return it rather than put a second card next to it.
 * `unconfirmed` is NOT, because the ledger owns it from that point on.
 */
export const ACTIVE_STATES: readonly OutboxState[] = [
  'awaiting_review',
  'awaiting_approval',
  'approved',
  'sending',
  'failed',
];

/** An advisory reviewer's verdict. Never blocks and never approves (O-D4). */
export type ReviewVerdict = 'pass' | 'fail' | 'unclear' | 'unavailable';

/** One reviewer pass, always tagged with the revision it read. */
export interface ReviewReceipt {
  verdict: ReviewVerdict;
  /** The reviewer's stated reasons, or why it was unavailable. */
  reasons: string;
  /** The revision the reviewer actually read. A later human edit does not
   *  re-run the review, so the receipt stays labelled with this number. */
  revision: number;
  reviewedAt: number;
}

/** One immutable revision of the text. */
export interface OutboxRevision {
  itemId: string;
  revision: number;
  text: string;
  contentHash: string;
  /** `agent` for the proposal, otherwise the id of the human who edited. */
  author: string;
  createdAt: number;
}

export interface OutboxItem {
  id: string;
  personalityId: string;
  /** The bot that will send. Resolved at propose and never edited. */
  botKey: string;
  platform: string;
  chatId: string;
  threadId?: string;
  /** The current revision number; 1 for a fresh proposal. */
  revision: number;
  /** Hash of the CURRENT revision — what an approval must match. */
  contentHash: string;
  state: OutboxState;
  createdAt: number;
  updatedAt: number;
  /** The advisory reviewer personality, if the policy names one. */
  approverPersonality?: string;
  review?: ReviewReceipt;
  /** Who approved, and which revision they approved. Cleared by an edit,
   *  a revoke, and a rejection — the approval belongs to a revision. */
  approvedBy?: string;
  approvedAt?: number;
  approvedRevision?: number;
  /** When the dispatcher claimed the row (`approved` → `sending`). */
  claimedAt?: number;
  sentAt?: number;
  /** Set when the item reaches `unconfirmed`: the ledger row that owns the
   *  retry from then on. */
  obligationId?: string;
  /** Why the item is `failed` — shown next to the human's Retry action. */
  failureReason?: string;
  /** Why the item was rejected. */
  rejectionReason?: string;
  /** The lane the proposing turn ran in, for the UI's "drafted in" line. */
  originSessionKey?: string;
}

export interface ProposeInput {
  personalityId: string;
  botKey: string;
  platform: string;
  chatId: string;
  threadId?: string;
  text: string;
  /** Names the advisory reviewer; absent means the item goes straight to a
   *  human (`awaiting_approval`). */
  approverPersonality?: string;
  originSessionKey?: string;
}

export interface ProposeResult {
  item: OutboxItem;
  /**
   * `false` when an active item with the same `(personalityId, contentHash)`
   * already existed and is being returned instead.
   *
   * This is idempotent PROPOSAL, not outbound dedup: it exists so a model that
   * retries its tool call does not put two identical cards in front of the same
   * human. Outbound dedup is the gateway's `MessageDedupCache`, and it stays
   * there — the outbox has no dedup of its own.
   */
  created: boolean;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS outbox_items (
    id                    TEXT PRIMARY KEY,
    personality_id        TEXT NOT NULL,
    bot_key               TEXT NOT NULL,
    platform              TEXT NOT NULL,
    chat_id               TEXT NOT NULL,
    thread_id             TEXT,
    revision              INTEGER NOT NULL,
    content_hash          TEXT NOT NULL,
    state                 TEXT NOT NULL,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL,
    approver_personality  TEXT,
    review_verdict        TEXT,
    review_reasons        TEXT,
    review_revision       INTEGER,
    reviewed_at           INTEGER,
    approved_by           TEXT,
    approved_at           INTEGER,
    approved_revision     INTEGER,
    claimed_at            INTEGER,
    sent_at               INTEGER,
    obligation_id         TEXT,
    failure_reason        TEXT,
    rejection_reason      TEXT,
    origin_session_key    TEXT
  ) STRICT;

  -- The dispatcher's poll is "approved rows for my bots", every 5s.
  CREATE INDEX IF NOT EXISTS outbox_state_bot ON outbox_items(state, bot_key);
  -- Expiry and stale reconciliation both scan by state within a time window.
  CREATE INDEX IF NOT EXISTS outbox_state_updated ON outbox_items(state, updated_at);
  -- Idempotent propose.
  CREATE INDEX IF NOT EXISTS outbox_personality_hash
    ON outbox_items(personality_id, content_hash);

  CREATE TABLE IF NOT EXISTS outbox_revisions (
    item_id      TEXT NOT NULL,
    revision     INTEGER NOT NULL,
    text         TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    author       TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (item_id, revision)
  ) STRICT;
`;

interface ItemRow {
  id: string;
  personality_id: string;
  bot_key: string;
  platform: string;
  chat_id: string;
  thread_id: string | null;
  revision: number;
  content_hash: string;
  state: string;
  created_at: number;
  updated_at: number;
  approver_personality: string | null;
  review_verdict: string | null;
  review_reasons: string | null;
  review_revision: number | null;
  reviewed_at: number | null;
  approved_by: string | null;
  approved_at: number | null;
  approved_revision: number | null;
  claimed_at: number | null;
  sent_at: number | null;
  obligation_id: string | null;
  failure_reason: string | null;
  rejection_reason: string | null;
  origin_session_key: string | null;
}

interface RevisionRow {
  item_id: string;
  revision: number;
  text: string;
  content_hash: string;
  author: string;
  created_at: number;
}

function rowToItem(r: ItemRow): OutboxItem {
  return {
    id: r.id,
    personalityId: r.personality_id,
    botKey: r.bot_key,
    platform: r.platform,
    chatId: r.chat_id,
    threadId: r.thread_id ?? undefined,
    revision: r.revision,
    contentHash: r.content_hash,
    state: r.state as OutboxState,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    approverPersonality: r.approver_personality ?? undefined,
    review:
      r.review_verdict === null || r.review_revision === null || r.reviewed_at === null
        ? undefined
        : {
            verdict: r.review_verdict as ReviewVerdict,
            reasons: r.review_reasons ?? '',
            revision: r.review_revision,
            reviewedAt: r.reviewed_at,
          },
    approvedBy: r.approved_by ?? undefined,
    approvedAt: r.approved_at ?? undefined,
    approvedRevision: r.approved_revision ?? undefined,
    claimedAt: r.claimed_at ?? undefined,
    sentAt: r.sent_at ?? undefined,
    obligationId: r.obligation_id ?? undefined,
    failureReason: r.failure_reason ?? undefined,
    rejectionReason: r.rejection_reason ?? undefined,
    originSessionKey: r.origin_session_key ?? undefined,
  };
}

function rowToRevision(r: RevisionRow): OutboxRevision {
  return {
    itemId: r.item_id,
    revision: r.revision,
    text: r.text,
    contentHash: r.content_hash,
    author: r.author,
    createdAt: r.created_at,
  };
}

/** Short, greppable, and safe inside a Telegram callback payload
 *  (`obx:a:<id>:<rev>` has a 64-byte budget), unlike a full UUID. */
function newItemId(): string {
  return `obx_${randomBytes(8).toString('hex')}`;
}

/**
 * The store contract, so surfaces can inject a fake without a SQLite file.
 * `SQLiteOutboxStore` is the only shipped implementation.
 *
 * Every mutating method returns whether it changed a row. That boolean is not
 * a convenience: it is the outcome of a conditional `UPDATE`, which is how a
 * stale approval and a lost claim race are detected at all.
 */
export interface OutboxStore {
  propose(input: ProposeInput, now?: number): ProposeResult;
  get(id: string): OutboxItem | null;
  getRevision(id: string, revision: number): OutboxRevision | null;
  listRevisions(id: string): OutboxRevision[];
  listByPersonality(personalityId: string, limit?: number): OutboxItem[];
  listByState(states: readonly OutboxState[], limit?: number): OutboxItem[];

  attachReview(id: string, receipt: ReviewReceipt, now?: number): boolean;
  approve(
    id: string,
    revision: number,
    contentHash: string,
    approvedBy: string,
    now?: number,
  ): boolean;
  edit(id: string, revision: number, text: string, author: string, now?: number): OutboxItem | null;
  reject(id: string, reason: string, now?: number): boolean;
  revoke(id: string, now?: number): boolean;
  retry(id: string, approvedBy: string, now?: number): boolean;

  listClaimable(botKeys: readonly string[]): OutboxItem[];
  claim(id: string, now?: number): boolean;
  releaseClaim(id: string, now?: number): boolean;
  markSent(id: string, now?: number): boolean;
  markUnconfirmed(id: string, obligationId: string, now?: number): boolean;
  markFailed(id: string, reason: string, now?: number): boolean;

  expirePending(now?: number): number;
  expireApprovals(now?: number): number;
  listStaleReviews(now?: number): OutboxItem[];
  listStaleSending(now?: number): OutboxItem[];

  close(): void;
}

// ---------------------------------------------------------------------------
// SQLiteOutboxStore
// ---------------------------------------------------------------------------

export class SQLiteOutboxStore implements OutboxStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    // Same raw-fs carve-out the other SQLite stores take: mkdir -p the parent
    // directory before opening. `Storage` covers ~/.ethos/ data IO, not
    // bootstrapping the DB file's own enclosing directory. `:memory:` has no
    // parent path, so skip.
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // `synchronous` is left at SQLite's FULL default ON PURPOSE, and pinned by
    // a `durability posture` test in `__tests__`. See CLAUDE.md's roster: a
    // queued publication is work owed to a person, and under NORMAL a power cut
    // can roll back the commit that recorded the human's approve — the
    // publication then never goes out and nothing says why. The write path is a
    // handful of commits per publication on a human's cadence, so the fsync
    // costs nothing that matters here.
    //
    // The file is opened by the gateway (dispatcher) and web-api (decisions)
    // independently, and can be shared cross-process. An explicit busy timeout
    // makes a concurrent write wait rather than throw SQLITE_BUSY.
    this.db.pragma('busy_timeout = 5000');

    migrate(this.db, {
      name: 'outbox',
      targetVersion: 1,
      baseline: SCHEMA,
    });
  }

  // -- proposal -------------------------------------------------------------

  propose(input: ProposeInput, now: number = Date.now()): ProposeResult {
    // Normalize BEFORE hashing, not after. `''` is not a smaller thread id, it
    // is an absent one, and the column stores NULL for it — so hashing the raw
    // input would bind the item to a thread value the row does not hold, and
    // `verifyBinding` (which can only recompute from the ROW) would fail every
    // such publication at the last step before delivery.
    const threadId = input.threadId ? input.threadId : null;
    const contentHash = computeContentHash({ ...input, threadId });
    const initialState: OutboxState = input.approverPersonality
      ? 'awaiting_review'
      : 'awaiting_approval';

    const run = this.db.transaction((): ProposeResult => {
      // Idempotent propose. Scoped to `personalityId` as well as the hash even
      // though the hash already covers the personality id: the index is on the
      // pair, and a query that matches it is the one that stays cheap as the
      // table grows.
      const placeholders = ACTIVE_STATES.map(() => '?').join(', ');
      const existing = this.db
        .prepare(
          `SELECT * FROM outbox_items
           WHERE personality_id = ? AND content_hash = ? AND state IN (${placeholders})
           ORDER BY created_at ASC, rowid ASC
           LIMIT 1`,
        )
        .get(input.personalityId, contentHash, ...ACTIVE_STATES) as ItemRow | undefined;
      if (existing) return { item: rowToItem(existing), created: false };

      const id = newItemId();
      this.db
        .prepare(
          `INSERT INTO outbox_items
           (id, personality_id, bot_key, platform, chat_id, thread_id, revision, content_hash,
            state, created_at, updated_at, approver_personality, origin_session_key)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.personalityId,
          input.botKey,
          input.platform,
          input.chatId,
          threadId,
          contentHash,
          initialState,
          now,
          now,
          input.approverPersonality ?? null,
          input.originSessionKey ?? null,
        );
      this.db
        .prepare(
          `INSERT INTO outbox_revisions (item_id, revision, text, content_hash, author, created_at)
           VALUES (?, 1, ?, ?, 'agent', ?)`,
        )
        .run(id, input.text, contentHash, now);

      const row = this.db.prepare('SELECT * FROM outbox_items WHERE id = ?').get(id) as ItemRow;
      return { item: rowToItem(row), created: true };
    });
    return run();
  }

  // -- reads ----------------------------------------------------------------

  get(id: string): OutboxItem | null {
    const row = this.db.prepare('SELECT * FROM outbox_items WHERE id = ?').get(id) as
      | ItemRow
      | undefined;
    return row ? rowToItem(row) : null;
  }

  getRevision(id: string, revision: number): OutboxRevision | null {
    const row = this.db
      .prepare('SELECT * FROM outbox_revisions WHERE item_id = ? AND revision = ?')
      .get(id, revision) as RevisionRow | undefined;
    return row ? rowToRevision(row) : null;
  }

  listRevisions(id: string): OutboxRevision[] {
    const rows = this.db
      .prepare('SELECT * FROM outbox_revisions WHERE item_id = ? ORDER BY revision ASC')
      .all(id) as RevisionRow[];
    return rows.map(rowToRevision);
  }

  listByPersonality(personalityId: string, limit = 100): OutboxItem[] {
    // `rowid` tie-break: items proposed inside one millisecond otherwise come
    // back in an arbitrary order, which makes a paged UI flicker.
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox_items WHERE personality_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(personalityId, limit) as ItemRow[];
    return rows.map(rowToItem);
  }

  listByState(states: readonly OutboxState[], limit = 100): OutboxItem[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox_items WHERE state IN (${placeholders})
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...states, limit) as ItemRow[];
    return rows.map(rowToItem);
  }

  // -- review ---------------------------------------------------------------

  /**
   * Attach an advisory receipt and release the item to the human.
   *
   * Conditional on `awaiting_review`: a receipt that arrives after the stale
   * reconciler already released the item must not rewrite a verdict the human
   * may have read, and must not drag an approved item back.
   */
  attachReview(id: string, receipt: ReviewReceipt, now: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbox_items
         SET state = 'awaiting_approval', review_verdict = ?, review_reasons = ?,
             review_revision = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ? AND state = 'awaiting_review'`,
      )
      .run(receipt.verdict, receipt.reasons, receipt.revision, receipt.reviewedAt, now, id);
    return result.changes === 1;
  }

  // -- human decisions ------------------------------------------------------

  /**
   * Enforcement point 1 of the binding.
   *
   * ONE conditional UPDATE carrying every fact the approver was shown: the id,
   * the revision they read, the hash of that revision, and the state they saw
   * it in. Zero rows changed means something moved underneath them — an edit,
   * a rejection, an expiry, or a peer's approval — and the caller is told
   * CONFLICT rather than publishing text nobody approved.
   */
  approve(
    id: string,
    revision: number,
    contentHash: string,
    approvedBy: string,
    now: number = Date.now(),
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbox_items
         SET state = 'approved', approved_by = ?, approved_at = ?, approved_revision = ?,
             updated_at = ?
         WHERE id = ? AND revision = ? AND content_hash = ? AND state = 'awaiting_approval'`,
      )
      .run(approvedBy, now, revision, now, id, revision, contentHash);
    return result.changes === 1;
  }

  /**
   * Enforcement point 2 of the binding.
   *
   * An edit writes revision n+1 with a new hash and clears the approval
   * columns, so an approval that belonged to revision n cannot survive into
   * n+1. `expectedRevision` makes two humans editing the same card race
   * safely: the second one's update touches no row.
   *
   * Only the TEXT changes. Destination and sender are fixed at propose; to
   * publish somewhere else the item is rejected and the agent proposes again.
   */
  edit(
    id: string,
    expectedRevision: number,
    text: string,
    author: string,
    now: number = Date.now(),
  ): OutboxItem | null {
    const run = this.db.transaction((): OutboxItem | null => {
      const current = this.db.prepare('SELECT * FROM outbox_items WHERE id = ?').get(id) as
        | ItemRow
        | undefined;
      if (!current) return null;
      const next = expectedRevision + 1;
      const hash = computeContentHash({
        personalityId: current.personality_id,
        botKey: current.bot_key,
        platform: current.platform,
        chatId: current.chat_id,
        threadId: current.thread_id,
        text,
      });
      const result = this.db
        .prepare(
          `UPDATE outbox_items
           SET revision = ?, content_hash = ?, state = 'awaiting_approval',
               approved_by = NULL, approved_at = NULL, approved_revision = NULL,
               updated_at = ?
           WHERE id = ? AND revision = ? AND state = 'awaiting_approval'`,
        )
        .run(next, hash, now, id, expectedRevision);
      if (result.changes !== 1) return null;
      this.db
        .prepare(
          `INSERT INTO outbox_revisions (item_id, revision, text, content_hash, author, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, next, text, hash, author, now);
      const row = this.db.prepare('SELECT * FROM outbox_items WHERE id = ?').get(id) as ItemRow;
      return rowToItem(row);
    });
    return run();
  }

  /**
   * Refuse the publication. Conditional on `awaiting_approval` because that is
   * the only state a human sees the item in: while it is `awaiting_review`
   * nothing has been shown to anybody yet.
   */
  reject(id: string, reason: string, now: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbox_items
         SET state = 'rejected', rejection_reason = ?, updated_at = ?
         WHERE id = ? AND state = 'awaiting_approval'`,
      )
      .run(reason, now, id);
    return result.changes === 1;
  }

  /**
   * Withdraw an approval before the dispatcher claims it.
   *
   * Conditional on `approved`, which is what settles the race with `claim()`:
   * whichever conditional UPDATE lands first wins, and after the claim the
   * honest answer to the human is "sent — Ethos cannot unsend this".
   */
  revoke(id: string, now: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbox_items
         SET state = 'awaiting_approval', approved_by = NULL, approved_at = NULL,
             approved_revision = NULL, updated_at = ?
         WHERE id = ? AND state = 'approved'`,
      )
      .run(now, id);
    return result.changes === 1;
  }

  /**
   * Put a `failed` item back in the approved pool at the SAME revision.
   *
   * The human is re-approving text they already approved, so no new revision is
   * written; `approved_revision` is re-stamped from the item's current revision
   * so the binding still names a revision that exists.
   */
  retry(id: string, approvedBy: string, now: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbox_items
         SET state = 'approved', approved_by = ?, approved_at = ?, approved_revision = revision,
             failure_reason = NULL, claimed_at = NULL, updated_at = ?
         WHERE id = ? AND state = 'failed'`,
      )
      .run(approvedBy, now, now, id);
    return result.changes === 1;
  }

  // -- delivery -------------------------------------------------------------

  /**
   * Approved items this process could deliver.
   *
   * Ownership-filtered by `botKey` for the same reason `DeliveryLedger.
   * listPending` is: two gateways sharing one file must not deliver each
   * other's traffic. Oldest first — a publication that has waited longest goes
   * out first.
   */
  listClaimable(botKeys: readonly string[]): OutboxItem[] {
    if (botKeys.length === 0) return [];
    const placeholders = botKeys.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox_items
         WHERE state = 'approved' AND bot_key IN (${placeholders})
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(...botKeys) as ItemRow[];
    return rows.map(rowToItem);
  }

  /**
   * Atomically take a row for delivery. `false` means a peer won, or the human
   * revoked in the gap between the list and the claim.
   */
  claim(id: string, now: number = Date.now()): boolean {
    const run = this.db.transaction((): boolean => {
      const result = this.db
        .prepare(
          `UPDATE outbox_items SET state = 'sending', claimed_at = ?, updated_at = ?
           WHERE id = ? AND state = 'approved'`,
        )
        .run(now, now, id);
      return result.changes === 1;
    });
    return run();
  }

  /**
   * Hand a claimed row back, unsent — the pre-send refusal path (the bot that
   * would send is not served by this process any more). The approval is intact,
   * so the item returns to `approved` rather than to the human.
   */
  releaseClaim(id: string, now: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbox_items SET state = 'approved', claimed_at = NULL, updated_at = ?
         WHERE id = ? AND state = 'sending'`,
      )
      .run(now, id);
    return result.changes === 1;
  }

  markSent(id: string, now: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbox_items SET state = 'sent', sent_at = ?, updated_at = ?
         WHERE id = ? AND state = 'sending'`,
      )
      .run(now, now, id);
    return result.changes === 1;
  }

  /**
   * The platform did not confirm. The obligation id is kept so the UI can show
   * the ledger row's live status; the ledger owns every retry from here.
   */
  markUnconfirmed(id: string, obligationId: string, now: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbox_items SET state = 'unconfirmed', obligation_id = ?, updated_at = ?
         WHERE id = ? AND state = 'sending'`,
      )
      .run(obligationId, now, id);
    return result.changes === 1;
  }

  /**
   * Nothing was sent and the human has to decide again.
   *
   * Conditional on `sending`, which is the lifecycle's only edge into
   * `failed` — so every refusal that ends here (a binding mismatch, a rebound
   * bot, a reconciled crash) runs on a row this process has CLAIMED. A
   * dispatcher that failed an unclaimed `approved` row would be failing a
   * publication a peer may be delivering right now.
   */
  markFailed(id: string, reason: string, now: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbox_items SET state = 'failed', failure_reason = ?, updated_at = ?
         WHERE id = ? AND state = 'sending'`,
      )
      .run(reason, now, id);
    return result.changes === 1;
  }

  // -- expiry ---------------------------------------------------------------

  /**
   * Expire items still waiting on a human {@link PENDING_EXPIRY_MS} after they
   * were PROPOSED. Measured from `created_at`, not `updated_at`: a reviewer
   * receipt or an edit touches the row, and restarting the week's clock every
   * time somebody looks at a card is how a stale publication lives forever.
   */
  expirePending(now: number = Date.now()): number {
    const result = this.db
      .prepare(
        `UPDATE outbox_items SET state = 'expired', updated_at = ?
         WHERE state IN ('awaiting_review', 'awaiting_approval') AND created_at < ?`,
      )
      .run(now, now - PENDING_EXPIRY_MS);
    return result.changes;
  }

  /**
   * Expire approvals nobody delivered within {@link APPROVAL_VALIDITY_MS}.
   * Measured from `approved_at` — the window is the approval's, not the item's.
   */
  expireApprovals(now: number = Date.now()): number {
    const result = this.db
      .prepare(
        `UPDATE outbox_items SET state = 'expired', updated_at = ?
         WHERE state = 'approved' AND approved_at IS NOT NULL AND approved_at < ?`,
      )
      .run(now, now - APPROVAL_VALIDITY_MS);
    return result.changes;
  }

  /** `awaiting_review` rows whose reviewer never came back. */
  listStaleReviews(now: number = Date.now()): OutboxItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox_items
         WHERE state = 'awaiting_review' AND updated_at < ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(now - STALE_THRESHOLD_MS) as ItemRow[];
    return rows.map(rowToItem);
  }

  /**
   * `sending` rows claimed by a process that is gone. The caller reconciles
   * each against the delivery ledger — a ledger row means `unconfirmed`, no
   * ledger row proves nothing was sent (`sendTracked` writes the row BEFORE the
   * platform call) and the item goes to `failed` for a human to retry.
   */
  listStaleSending(now: number = Date.now()): OutboxItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox_items
         WHERE state = 'sending' AND claimed_at IS NOT NULL AND claimed_at < ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(now - STALE_THRESHOLD_MS) as ItemRow[];
    return rows.map(rowToItem);
  }

  close(): void {
    this.db.close();
  }
}
