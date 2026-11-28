import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database, { migrate } from '@ethosagent/sqlite';
import type { WorldId } from '@ethosagent/types';
import { z } from 'zod';
import { canonicalJson, type SchemaIssue } from './schema-model';

// ---------------------------------------------------------------------------
// SQLiteWorldServiceStore: the world-service's own STRICT store,
// `<dataDir>/worlds/service.db` (plan world-model Tasks 2.2, 2.3). The only
// owner of `schema_versions`, `schema_load_errors`, `proposals` and
// `proposal_tombstones`; WorldSchemaService and WorldService reach them
// through this class.
//
// Guarantees, each pinned by `__tests__/schema-service.test.ts`:
//   - every table is STRICT and `synchronous = FULL` with WAL: a pending
//     proposal is a decision owed to the user and a lost accept silently drops
//     it, the outbox reasoning in .claude/rules/sqlite-durability.md
//     ('schema_versions is STRICT; durability posture is FULL').
//   - `propose` dedups on a fingerprint (one pending row per payload), refuses
//     a rejected payload (tombstone), and enforces the per-world cap and the
//     TTL ('same payload twice → one pending row', 'rejected fingerprint is
//     not re-proposed', 'cap expires the oldest', 'ttl expires stale pending
//     proposals'); `inbox` orders conflicts first, then created_at, rowid
//     ('inbox lists conflicts first, then by created_at, rowid').
// ---------------------------------------------------------------------------

/** `<dataDir>/worlds/service.db` */
export function serviceDbPath(dataDir: string): string {
  return join(dataDir, 'worlds', 'service.db');
}

const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS schema_versions (
  world TEXT NOT NULL, version INTEGER NOT NULL, yaml TEXT NOT NULL, change_json TEXT NOT NULL,
  by TEXT NOT NULL, reason TEXT, at TEXT NOT NULL, PRIMARY KEY (world, version)
) STRICT;
CREATE TABLE IF NOT EXISTS schema_load_errors (
  world TEXT NOT NULL, at TEXT NOT NULL, errors_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY, world TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('assert','close','retire','schema','merge_entity')),
  payload_json TEXT NOT NULL, summary TEXT NOT NULL,
  conflict_with TEXT,
  source_ref TEXT NOT NULL, proposed_by TEXT NOT NULL,
  session_id TEXT, confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','superseded','expired')),
  batch_id TEXT, created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, reason TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_proposals_inbox ON proposals(world, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_pending_fp ON proposals(world, fingerprint) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS proposal_tombstones (
  world TEXT NOT NULL, fingerprint TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (world, fingerprint)
) STRICT;
`;

export interface ServiceStoreOptions {
  /** Injectable clock for tests. Defaults to `new Date()`. */
  now?: () => Date;
  /** Non-fatal errors (a stored row that fails to parse). Libraries never log. */
  onError?: (err: unknown) => void;
  /** Most pending proposals per world; past it the oldest expire. `world.proposals.cap`, default 500. */
  cap?: number;
  /** Days a proposal stays pending. `world.proposals.ttlDays`, default 30. */
  ttlDays?: number;
}

export interface SchemaVersionRow {
  rowid: number;
  world: WorldId;
  version: number;
  yaml: string;
  changeJson: string;
  by: string;
  reason: string | null;
  at: string;
}

export interface LoadErrorsRow {
  at: string;
  errors: SchemaIssue[];
}

export type ProposalKind = 'assert' | 'close' | 'retire' | 'schema' | 'merge_entity';

export interface ProposeInput {
  world: WorldId;
  kind: ProposalKind;
  payload: unknown;
  summary: string;
  conflictWith?: string | null;
  sourceRef: string;
  proposedBy: string;
  sessionId?: string | null;
  confidence?: number;
  batchId?: string | null;
}

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'superseded' | 'expired';

export interface ProposalRow {
  /** Selected explicitly: it is not part of `SELECT *` and breaks created_at ties. */
  rowid: number;
  id: string;
  world: WorldId;
  kind: ProposalKind;
  payload: unknown;
  summary: string;
  conflictWith: string | null;
  sourceRef: string;
  proposedBy: string;
  sessionId: string | null;
  confidence: number;
  fingerprint: string;
  status: ProposalStatus;
  batchId: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  reason: string | null;
}

interface ProposalDbRow {
  rowid: number;
  id: string;
  world: string;
  kind: ProposalKind;
  payload_json: string;
  summary: string;
  conflict_with: string | null;
  source_ref: string;
  proposed_by: string;
  session_id: string | null;
  confidence: number;
  fingerprint: string;
  status: ProposalStatus;
  batch_id: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  reason: string | null;
}

const PROPOSAL_COLS =
  'rowid, id, world, kind, payload_json, summary, conflict_with, source_ref, proposed_by, session_id, confidence, fingerprint, status, batch_id, created_at, decided_at, decided_by, reason';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CAP = 500;
const DEFAULT_TTL_DAYS = 30;

/** sha256 of the key-sorted payload: what dedup and tombstones compare. */
export function fingerprintOf(world: WorldId, kind: ProposalKind, payload: unknown): string {
  return createHash('sha256').update(canonicalJson({ world, kind, payload })).digest('hex');
}

const issuesZ = z.array(
  z.object({ line: z.number(), column: z.number().optional(), message: z.string() }),
);

interface SchemaVersionDbRow {
  rowid: number;
  world: string;
  version: number;
  yaml: string;
  change_json: string;
  by: string;
  reason: string | null;
  at: string;
}

const VERSION_COLS = 'rowid, world, version, yaml, change_json, by, reason, at';

export class SQLiteWorldServiceStore {
  protected readonly db: Database.Database;
  protected readonly clock: () => Date;
  protected readonly onError: (err: unknown) => void;
  protected readonly cap: number;
  protected readonly ttlDays: number;

  constructor(dbPath: string, options: ServiceStoreOptions = {}) {
    this.clock = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => {});
    this.cap = Math.max(1, Math.floor(options.cap ?? DEFAULT_CAP));
    this.ttlDays = options.ttlDays ?? DEFAULT_TTL_DAYS;
    // mkdir -p the DB's parent: the raw-fs carve-out in
    // .claude/rules/fs-carveouts-sqlite.md.
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // Explicit, not SQLite's implicit default. Pinned by 'schema_versions is
    // STRICT; durability posture is FULL'.
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    migrate(this.db, { name: 'world-service', targetVersion: SCHEMA_VERSION, baseline: DDL });
  }

  /** Release the database handle. */
  dispose(): void {
    this.db.close();
  }

  protected nowIso(): string {
    return this.clock().toISOString();
  }

  // ---- schema versions ------------------------------------------------------

  private toVersion(r: SchemaVersionDbRow): SchemaVersionRow {
    return {
      rowid: r.rowid,
      world: r.world as WorldId,
      version: r.version,
      yaml: r.yaml,
      changeJson: r.change_json,
      by: r.by,
      reason: r.reason,
      at: r.at,
    };
  }

  /** Newest first. */
  listSchemaVersions(world: WorldId): SchemaVersionRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${VERSION_COLS} FROM schema_versions WHERE world = ? ORDER BY version DESC, rowid DESC`,
      )
      .all(world) as SchemaVersionDbRow[];
    return rows.map((r) => this.toVersion(r));
  }

  latestSchemaVersion(world: WorldId): SchemaVersionRow | null {
    const r = this.db
      .prepare(
        `SELECT ${VERSION_COLS} FROM schema_versions WHERE world = ? ORDER BY version DESC, rowid DESC LIMIT 1`,
      )
      .get(world) as SchemaVersionDbRow | undefined;
    return r ? this.toVersion(r) : null;
  }

  insertSchemaVersion(row: {
    world: WorldId;
    version: number;
    yaml: string;
    changeJson: string;
    by: string;
    reason?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO schema_versions (world, version, yaml, change_json, by, reason, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.world,
        row.version,
        row.yaml,
        row.changeJson,
        row.by,
        row.reason ?? null,
        this.nowIso(),
      );
  }

  // ---- schema load errors ---------------------------------------------------

  /** Records a failed load. Returns false (and writes nothing) when the newest row already holds the same errors. */
  recordLoadErrors(world: WorldId, errors: SchemaIssue[]): boolean {
    const json = JSON.stringify(errors);
    const last = this.db
      .prepare(
        'SELECT rowid, errors_json FROM schema_load_errors WHERE world = ? ORDER BY at DESC, rowid DESC LIMIT 1',
      )
      .get(world) as { rowid: number; errors_json: string } | undefined;
    if (last?.errors_json === json) return false;
    this.db
      .prepare('INSERT INTO schema_load_errors (world, at, errors_json) VALUES (?, ?, ?)')
      .run(world, this.nowIso(), json);
    return true;
  }

  latestLoadErrors(world: WorldId): LoadErrorsRow | null {
    const r = this.db
      .prepare(
        'SELECT rowid, at, errors_json FROM schema_load_errors WHERE world = ? ORDER BY at DESC, rowid DESC LIMIT 1',
      )
      .get(world) as { rowid: number; at: string; errors_json: string } | undefined;
    if (!r) return null;
    try {
      const parsed = issuesZ.safeParse(JSON.parse(r.errors_json));
      if (parsed.success) return { at: r.at, errors: parsed.data };
      this.onError(parsed.error);
    } catch (err) {
      this.onError(err);
    }
    return null;
  }

  countLoadErrors(world: WorldId): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM schema_load_errors WHERE world = ?')
      .get(world) as { n: number };
    return r.n;
  }

  // ---- proposals ------------------------------------------------------------

  /**
   * Queues a proposal. The same payload twice is one pending row (the partial
   * unique index `idx_proposals_pending_fp`), a rejected payload is never
   * queued again (tombstone), pending rows past `ttlDays` are expired, and
   * past `cap` per world the oldest pending rows are expired. One transaction.
   * Pinned by proposals.test.ts.
   */
  propose(
    input: ProposeInput,
  ): { id: string; created: boolean; fingerprint: string } | { refused: 'tombstoned' } {
    const fingerprint = fingerprintOf(input.world, input.kind, input.payload);
    return this.db.transaction(() => {
      if (this.hasTombstone(input.world, fingerprint)) return { refused: 'tombstoned' as const };
      this.expireStale();
      const existing = this.db
        .prepare(
          `SELECT id FROM proposals WHERE world = ? AND fingerprint = ? AND status = 'pending'`,
        )
        .get(input.world, fingerprint) as { id: string } | undefined;
      if (existing) return { id: existing.id, created: false, fingerprint };

      const id = `p-${randomBytes(8).toString('hex')}`;
      this.db
        .prepare(
          `INSERT INTO proposals (id, world, kind, payload_json, summary, conflict_with, source_ref,
             proposed_by, session_id, confidence, fingerprint, status, batch_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          id,
          input.world,
          input.kind,
          JSON.stringify(input.payload),
          input.summary,
          input.conflictWith ?? null,
          input.sourceRef,
          input.proposedBy,
          input.sessionId ?? null,
          input.confidence ?? 1,
          fingerprint,
          input.batchId ?? null,
          this.nowIso(),
        );
      this.enforceCap(input.world);
      return { id, created: true, fingerprint };
    })();
  }

  /** Pending proposals in `world`: conflicts first, then oldest first, rowid breaking ties. */
  inbox(world: WorldId, opts: { batchId?: string } = {}): ProposalRow[] {
    this.expireStale();
    const where = ['world = ?', `status = 'pending'`];
    const params: string[] = [world];
    if (opts.batchId !== undefined) {
      where.push('batch_id = ?');
      params.push(opts.batchId);
    }
    const rows = this.db
      .prepare(
        `SELECT ${PROPOSAL_COLS} FROM proposals WHERE ${where.join(' AND ')}
         ORDER BY (conflict_with IS NULL), created_at, rowid`,
      )
      .all(...params) as ProposalDbRow[];
    return rows.map((r) => this.toProposal(r));
  }

  get(id: string): ProposalRow | null {
    const r = this.db.prepare(`SELECT ${PROPOSAL_COLS} FROM proposals WHERE id = ?`).get(id) as
      | ProposalDbRow
      | undefined;
    return r ? this.toProposal(r) : null;
  }

  /**
   * Records the decision on a pending proposal. A reject also writes the
   * tombstone in the same transaction, so a rejected payload is not proposed
   * again. Returns null when the proposal is not pending (already decided,
   * expired, or unknown).
   */
  decide(
    id: string,
    status: 'accepted' | 'rejected' | 'superseded',
    by: string,
    reason?: string,
  ): ProposalRow | null {
    return this.db.transaction(() => {
      const at = this.nowIso();
      const r = this.db
        .prepare(
          `UPDATE proposals SET status = ?, decided_at = ?, decided_by = ?, reason = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(status, at, by, reason ?? null, id);
      if (r.changes === 0) return null;
      const row = this.get(id);
      if (row && status === 'rejected') {
        this.db
          .prepare(
            'INSERT OR IGNORE INTO proposal_tombstones (world, fingerprint, at) VALUES (?, ?, ?)',
          )
          .run(row.world, row.fingerprint, at);
      }
      return row;
    })();
  }

  hasTombstone(world: WorldId, fingerprint: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 AS x FROM proposal_tombstones WHERE world = ? AND fingerprint = ?')
        .get(world, fingerprint) !== undefined
    );
  }

  /** Pending proposals in `world`. */
  countProposals(world: WorldId): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM proposals WHERE world = ? AND status = 'pending'`)
      .get(world) as { n: number };
    return r.n;
  }

  /** Pending rows older than `ttlDays` become `expired`. */
  private expireStale(): void {
    const cutoff = new Date(this.clock().getTime() - this.ttlDays * DAY_MS).toISOString();
    this.db
      .prepare(
        `UPDATE proposals SET status = 'expired', decided_at = ?, decided_by = 'system', reason = 'ttl'
         WHERE status = 'pending' AND created_at < ?`,
      )
      .run(this.nowIso(), cutoff);
  }

  /** Past `cap` pending rows in `world`, the oldest become `expired`. */
  private enforceCap(world: WorldId): void {
    const excess = this.countProposals(world) - this.cap;
    if (excess <= 0) return;
    this.db
      .prepare(
        `UPDATE proposals SET status = 'expired', decided_at = ?, decided_by = 'system', reason = 'cap'
         WHERE id IN (SELECT id FROM proposals WHERE world = ? AND status = 'pending'
                      ORDER BY created_at, rowid LIMIT ?)`,
      )
      .run(this.nowIso(), world, excess);
  }

  private toProposal(r: ProposalDbRow): ProposalRow {
    let payload: unknown = null;
    try {
      payload = JSON.parse(r.payload_json);
    } catch (err) {
      this.onError(err);
    }
    return {
      rowid: r.rowid,
      id: r.id,
      world: r.world as WorldId,
      kind: r.kind,
      payload,
      summary: r.summary,
      conflictWith: r.conflict_with,
      sourceRef: r.source_ref,
      proposedBy: r.proposed_by,
      sessionId: r.session_id,
      confidence: r.confidence,
      fingerprint: r.fingerprint,
      status: r.status,
      batchId: r.batch_id,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
      decidedBy: r.decided_by,
      reason: r.reason,
    };
  }
}
