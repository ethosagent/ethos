import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database, { migrate } from '@ethosagent/sqlite';
import type {
  AttributeFact,
  Edge,
  Entity,
  FactAuthor,
  GraphBundle,
  WorldId,
  WorldProviderCapabilities,
  WorldSchema,
  WriteResult,
} from '@ethosagent/types';
import { DDL, SCHEMA_VERSION, worldSchemaZ } from './schema';

// ---------------------------------------------------------------------------
// SQLiteWorldGraphProvider — the sqlite backend of the world graph contract.
// Own file `<dataDir>/worlds/graph.db` (plan world-model Task 1.2).
//
// Guarantees, each pinned by `__tests__/graph-store.test.ts`:
//   - every table is STRICT ('tables are STRICT');
//   - `synchronous = FULL`: graph.db is the source of truth for facts the user
//     typed in and nothing rebuilds it ('durability posture is FULL';
//     .claude/rules/sqlite-durability.md);
//   - facts are never deleted or rewritten except by a purge token, and a purge
//     is one transaction ('R3 facts are closed, never deleted',
//     'purge removes rows only with a token, in one transaction');
//   - ordered reads tie-break on an explicitly selected rowid
//     ('ordered reads tie-break on rowid').
// ---------------------------------------------------------------------------

export type Stmt = ReturnType<Database.Database['prepare']>;

/** `<dataDir>/worlds/graph.db` */
export function worldGraphDbPath(dataDir: string): string {
  return join(dataDir, 'worlds', 'graph.db');
}

export interface WorldGraphStoreOptions {
  /** Injectable clock for tests. Defaults to `new Date()`. */
  now?: () => Date;
  /** Non-fatal errors (a stored row that fails to parse). Libraries never log. */
  onError?: (err: unknown) => void;
}

export const MAX_HOPS = 3;

export interface EntityRow {
  rowid: number;
  id: string;
  world: string;
  type: string;
  name: string;
  aliases: string;
  recorded_at: string;
  retired_at: string | null;
  merged_into: string | null;
  source_ref: string;
  author: FactAuthor;
}

export interface AttributeRow {
  rowid: number;
  id: string;
  world: string;
  entity_id: string;
  key: string;
  value_json: string;
  valid_from: string | null;
  valid_to: string | null;
  recorded_at: string;
  retired_at: string | null;
  source_ref: string;
  author: FactAuthor;
  confidence: number;
}

export interface EdgeRow {
  rowid: number;
  id: string;
  world: string;
  type: string;
  from_id: string;
  to_id: string;
  attrs_json: string;
  valid_from: string | null;
  valid_to: string | null;
  recorded_at: string;
  retired_at: string | null;
  source_ref: string;
  author: FactAuthor;
  confidence: number;
}

// `rowid` is not part of `SELECT *`; every ordered read names it.
export const ENTITY_COLS =
  'rowid, id, world, type, name, aliases, recorded_at, retired_at, merged_into, source_ref, author';
export const ATTRIBUTE_COLS =
  'rowid, id, world, entity_id, key, value_json, valid_from, valid_to, recorded_at, retired_at, source_ref, author, confidence';
export const EDGE_COLS =
  'rowid, id, world, type, from_id, to_id, attrs_json, valid_from, valid_to, recorded_at, retired_at, source_ref, author, confidence';

function isWorld(w: string): w is WorldId {
  return w.startsWith('world:') || w.startsWith('personality:');
}

export class SQLiteWorldGraphProvider {
  protected readonly db: Database.Database;
  protected readonly clock: () => Date;
  protected readonly onError: (err: unknown) => void;

  constructor(dbPath: string, options: WorldGraphStoreOptions = {}) {
    this.clock = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => {});
    // mkdir -p the DB's parent: the same raw-fs carve-out as the other SQLite
    // stores (.claude/rules/fs-carveouts-sqlite.md).
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // Explicit, not SQLite's implicit default. Pinned by 'durability posture is FULL'.
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    migrate(this.db, { name: 'world-sqlite', targetVersion: SCHEMA_VERSION, baseline: DDL });
  }

  /** Release the database handle. (`close` is the contract's fact-closing method.) */
  dispose(): void {
    this.db.close();
  }

  capabilities(): WorldProviderCapabilities {
    return { bitemporal: true, fullText: true, vector: false, maxHops: MAX_HOPS };
  }

  /** `e-`/`a-`/`r-` plus 16 hex of a random 64-bit value. */
  newId(prefix: 'e' | 'a' | 'r'): string {
    return `${prefix}-${randomBytes(8).toString('hex')}`;
  }

  protected nowIso(): string {
    return this.clock().toISOString();
  }

  async getSchema(world: WorldId): Promise<WorldSchema | null> {
    const row = this.db.prepare('SELECT schema_json FROM schemas WHERE world = ?').get(world) as
      | { schema_json: string }
      | undefined;
    if (!row) return null;
    try {
      const parsed = worldSchemaZ.safeParse(JSON.parse(row.schema_json));
      if (parsed.success) return parsed.data;
      this.onError(parsed.error);
    } catch (err) {
      this.onError(err);
    }
    return null;
  }

  /** Stores the schema the service already validated; version rules live in WorldSchemaService. */
  async applySchema(world: WorldId, schema: WorldSchema): Promise<WriteResult> {
    const parsed = worldSchemaZ.safeParse(schema);
    if (!parsed.success) {
      return { ok: false, code: 'invalid', reason: parsed.error.message };
    }
    this.db
      .prepare(
        `INSERT INTO schemas (world, version, schema_json, applied_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(world) DO UPDATE SET version = excluded.version,
           schema_json = excluded.schema_json, applied_at = excluded.applied_at`,
      )
      .run(world, parsed.data.version, JSON.stringify(parsed.data), this.nowIso());
    return { ok: true, ids: [] };
  }

  async purge(
    world: WorldId,
    scope: { entityId?: string },
    reason: string,
  ): Promise<{ removed: number }> {
    const { entityId } = scope;
    const run = this.db.transaction((): number => {
      // The token is the only way past the *_no_delete triggers; it lives and
      // dies inside this transaction (test: 'purge removes rows only with a token…').
      this.db
        .prepare('INSERT INTO purge_tokens (world, entity_id, reason, at) VALUES (?, ?, ?, ?)')
        .run(world, entityId ?? null, reason, this.nowIso());
      let removed = 0;
      if (entityId === undefined) {
        removed += this.db.prepare('DELETE FROM edges WHERE world = ?').run(world).changes;
        removed += this.db.prepare('DELETE FROM attributes WHERE world = ?').run(world).changes;
        removed += this.db.prepare('DELETE FROM entities WHERE world = ?').run(world).changes;
      } else {
        removed += this.db
          .prepare('DELETE FROM edges WHERE world = ? AND (from_id = ? OR to_id = ?)')
          .run(world, entityId, entityId).changes;
        removed += this.db
          .prepare('DELETE FROM attributes WHERE world = ? AND entity_id = ?')
          .run(world, entityId).changes;
        removed += this.db
          .prepare('DELETE FROM entities WHERE world = ? AND id = ?')
          .run(world, entityId).changes;
      }
      this.db.prepare('DELETE FROM purge_tokens WHERE world = ?').run(world);
      return removed;
    });
    return { removed: run() };
  }

  async export(world: WorldId): Promise<GraphBundle> {
    const entities = this.db
      .prepare(`SELECT ${ENTITY_COLS} FROM entities WHERE world = ? ORDER BY recorded_at, rowid`)
      .all(world) as EntityRow[];
    const attributes = this.db
      .prepare(
        `SELECT ${ATTRIBUTE_COLS} FROM attributes WHERE world = ? ORDER BY recorded_at, rowid`,
      )
      .all(world) as AttributeRow[];
    const edges = this.db
      .prepare(`SELECT ${EDGE_COLS} FROM edges WHERE world = ? ORDER BY recorded_at, rowid`)
      .all(world) as EdgeRow[];
    return {
      schema: await this.getSchema(world),
      entities: entities.map((r) => this.toEntity(r)),
      attributes: attributes.map((r) => this.toAttribute(r)),
      edges: edges.map((r) => this.toEdge(r)),
    };
  }

  // ---- row mappers (shared with the read paths) ---------------------------

  protected worldOf(raw: string): WorldId {
    if (isWorld(raw)) return raw;
    // Unreachable through the contract (every write takes a WorldId); a row
    // written by hand is reported and kept readable.
    this.onError(new Error(`graph.db row has a malformed world id: ${raw}`));
    return `world:${raw}`;
  }

  protected parseJson<T>(text: string, fallback: T): unknown {
    try {
      return JSON.parse(text);
    } catch (err) {
      this.onError(err);
      return fallback;
    }
  }

  protected toEntity(r: EntityRow): Entity {
    const aliases = this.parseJson(r.aliases, []);
    return {
      id: r.id,
      world: this.worldOf(r.world),
      type: r.type,
      name: r.name,
      aliases: Array.isArray(aliases) ? aliases.filter((a) => typeof a === 'string') : [],
      recordedAt: r.recorded_at,
      retiredAt: r.retired_at,
      sourceRef: r.source_ref,
      author: r.author,
      mergedInto: r.merged_into,
    };
  }

  protected toAttribute(r: AttributeRow): AttributeFact {
    return {
      id: r.id,
      world: this.worldOf(r.world),
      entityId: r.entity_id,
      key: r.key,
      value: this.parseJson(r.value_json, null),
      validFrom: r.valid_from,
      validTo: r.valid_to,
      recordedAt: r.recorded_at,
      retiredAt: r.retired_at,
      sourceRef: r.source_ref,
      author: r.author,
      confidence: r.confidence,
    };
  }

  protected toEdge(r: EdgeRow): Edge {
    const attrs = this.parseJson(r.attrs_json, {});
    return {
      id: r.id,
      world: this.worldOf(r.world),
      type: r.type,
      fromId: r.from_id,
      toId: r.to_id,
      attrs:
        attrs !== null && typeof attrs === 'object' && !Array.isArray(attrs)
          ? Object.fromEntries(Object.entries(attrs))
          : {},
      validFrom: r.valid_from,
      validTo: r.valid_to,
      recordedAt: r.recorded_at,
      retiredAt: r.retired_at,
      sourceRef: r.source_ref,
      author: r.author,
      confidence: r.confidence,
    };
  }
}
