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
CREATE TABLE IF NOT EXISTS proposal_tombstones (
  world TEXT NOT NULL, fingerprint TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (world, fingerprint)
) STRICT;
`;

export interface ServiceStoreOptions {
  /** Injectable clock for tests. Defaults to `new Date()`. */
  now?: () => Date;
  /** Non-fatal errors (a stored row that fails to parse). Libraries never log. */
  onError?: (err: unknown) => void;
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

  constructor(dbPath: string, options: ServiceStoreOptions = {}) {
    this.clock = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => {});
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
    return this.listSchemaVersions(world)[0] ?? null;
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

  // ---- proposals (flesh-out in Task 2.3) ------------------------------------

  /** Inserts a pending proposal. Task 2.3 adds dedup, tombstones, the cap and the TTL. */
  createProposal(input: ProposeInput): string {
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
        fingerprintOf(input.world, input.kind, input.payload),
        input.batchId ?? null,
        this.nowIso(),
      );
    return id;
  }

  /** Pending proposals in `world`. */
  countProposals(world: WorldId): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM proposals WHERE world = ? AND status = 'pending'`)
      .get(world) as { n: number };
    return r.n;
  }
}
