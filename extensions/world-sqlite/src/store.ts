import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database, { migrate } from '@ethosagent/sqlite';
import type {
  AttributeFact,
  AttrSpec,
  ChangeRow,
  Edge,
  Entity,
  FactAuthor,
  FactInput,
  Facts,
  GraphBundle,
  GraphQuery,
  ImportReport,
  Subgraph,
  TimeSlice,
  WorldGraphProvider,
  WorldId,
  WorldProviderCapabilities,
  WorldSchema,
  WriteResult,
} from '@ethosagent/types';
import { walkNeighbours, walkPaths } from './hops';
import { DDL, SCHEMA_VERSION, worldSchemaZ } from './schema';
import { FTS_DDL, searchEntityRowids, toMatchQuery } from './search';

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
//     ('ordered reads tie-break on rowid');
//   - every read applies the two-clock time slice, `sliceClause` below
//     (__tests__/facts.test.ts: 'handover…', 'knownAt…', 'retire hides…');
//   - `assert` refuses a fact the stored schema does not allow and writes
//     nothing from that batch ('assert refuses an edge between types the
//     schema does not allow'); it never closes another fact
//     ('attribute change closes nothing by itself');
//   - `close` refuses a fact whose valid_to is already set ('handover…').
//   - hops are depth-capped at capabilities().maxHops (hops.test.ts '2 hops from
//     Payments reaches Ravi and Kafka, not past') and entity text is searched
//     through quoted FTS5 tokens (search.test.ts 'FTS operators in text are inert').
//   Timestamps are ISO-8601 UTC strings compared lexicographically.
// ---------------------------------------------------------------------------

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
/** A subgraph is cut at this many entities and reports `truncated`. */
export const NEIGHBOUR_LIMIT = 200;

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

/** The Ethos-clock half of the slice: recorded by `knownAt` and not retired by then. */
const KNOWN_SQL = '(recorded_at <= ? AND (retired_at IS NULL OR retired_at > ?))';
/** The world-clock half: the fact holds at `asOf`. NULL valid_from = unknown start. */
const WORLD_SQL =
  '((valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to > ?))';

function isWorld(w: string): w is WorldId {
  return w.startsWith('world:') || w.startsWith('personality:');
}

function checkAttr(spec: AttrSpec, value: unknown): string | null {
  switch (spec.type) {
    case 'string':
    case 'date':
    case 'url': {
      if (typeof value !== 'string') return `expected ${spec.type}`;
      if (spec.type === 'date' && Number.isNaN(Date.parse(value))) return 'expected a date';
      if (spec.type === 'url' && !URL.canParse(value)) return 'expected a url';
      if (spec.enum && !spec.enum.includes(value)) return `not one of ${spec.enum.join(', ')}`;
      if (spec.min !== undefined && value.length < spec.min) return `shorter than ${spec.min}`;
      if (spec.max !== undefined && value.length > spec.max) return `longer than ${spec.max}`;
      return null;
    }
    case 'int':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `expected ${spec.type}`;
      if (spec.type === 'int' && !Number.isInteger(value)) return 'expected int';
      if (spec.min !== undefined && value < spec.min) return `below ${spec.min}`;
      if (spec.max !== undefined && value > spec.max) return `above ${spec.max}`;
      return null;
    }
    case 'bool':
      return typeof value === 'boolean' ? null : 'expected bool';
  }
}

function checkAttrs(
  specs: Record<string, AttrSpec>,
  attrs: Record<string, unknown>,
  where: string,
): string | null {
  for (const [key, value] of Object.entries(attrs)) {
    const spec = specs[key];
    if (!spec) return `${where}: attribute '${key}' is not in the schema`;
    const bad = checkAttr(spec, value);
    if (bad) return `${where}: attribute '${key}' ${bad}`;
  }
  return null;
}

const isIso = (s: string): boolean => !Number.isNaN(Date.parse(s));

/** `?, ?, ?` for an `IN (...)` list of `n` bound values. */
const placeholders = (n: number): string => Array(n).fill('?').join(', ');

export class SQLiteWorldGraphProvider implements WorldGraphProvider {
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
    migrate(this.db, {
      name: 'world-sqlite',
      targetVersion: SCHEMA_VERSION,
      baseline: DDL + FTS_DDL,
    });
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

  // ---- writes ---------------------------------------------------------------

  /** One batch, all or nothing: every fact is checked before the first insert. */
  async assert(world: WorldId, facts: FactInput[]): Promise<WriteResult> {
    const schema = await this.getSchema(world);
    const pending: Array<() => string> = [];
    const entityTypes = new Map<string, string>();
    const typeOf = (id: string): string | null => {
      const cached = entityTypes.get(id);
      if (cached !== undefined) return cached;
      const row = this.db
        .prepare('SELECT type FROM entities WHERE world = ? AND id = ? AND retired_at IS NULL')
        .get(world, id) as { type: string } | undefined;
      if (row) entityTypes.set(id, row.type);
      return row?.type ?? null;
    };
    const fail = (code: 'not_found' | 'schema' | 'invalid', reason: string): WriteResult => ({
      ok: false,
      code,
      reason,
    });
    const at = this.nowIso();

    for (const f of facts) {
      if (f.sourceRef.trim() === '') return fail('invalid', 'sourceRef is required');
      if (f.kind === 'entity') {
        if (f.name.trim() === '') return fail('invalid', 'entity name is required');
        if (schema && !schema.entities[f.type]) {
          return fail('schema', `entity type '${f.type}' is not in the schema`);
        }
        pending.push(() => {
          const id = this.newId('e');
          this.db
            .prepare(
              `INSERT INTO entities (id, world, type, name, aliases, recorded_at, source_ref, author)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              world,
              f.type,
              f.name,
              JSON.stringify(f.aliases ?? []),
              at,
              f.sourceRef,
              f.author,
            );
          return id;
        });
        continue;
      }
      if (f.validFrom !== undefined && !isIso(f.validFrom)) {
        return fail('invalid', `validFrom '${f.validFrom}' is not a date`);
      }
      if (f.confidence < 0 || f.confidence > 1 || Number.isNaN(f.confidence)) {
        return fail('invalid', 'confidence must be between 0 and 1');
      }
      if (f.kind === 'attribute') {
        const type = typeOf(f.entityId);
        if (type === null) return fail('not_found', `entity ${f.entityId} not found`);
        if (schema) {
          const spec = schema.entities[type]?.attrs[f.key];
          if (!spec) return fail('schema', `${type}: attribute '${f.key}' is not in the schema`);
          const bad = checkAttr(spec, f.value);
          if (bad) return fail('schema', `${type}.${f.key} ${bad}`);
        }
        const valueJson = JSON.stringify(f.value);
        if (valueJson === undefined) return fail('invalid', 'attribute value is not JSON');
        pending.push(() => {
          const id = this.newId('a');
          this.db
            .prepare(
              `INSERT INTO attributes (id, world, entity_id, key, value_json, valid_from, recorded_at,
                 source_ref, author, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              world,
              f.entityId,
              f.key,
              valueJson,
              f.validFrom ?? null,
              at,
              f.sourceRef,
              f.author,
              f.confidence,
            );
          return id;
        });
        continue;
      }
      const fromType = typeOf(f.fromId);
      if (fromType === null) return fail('not_found', `entity ${f.fromId} not found`);
      const toType = typeOf(f.toId);
      if (toType === null) return fail('not_found', `entity ${f.toId} not found`);
      if (schema) {
        const spec = schema.edges[f.type];
        if (!spec) return fail('schema', `edge type '${f.type}' is not in the schema`);
        if (!spec.from.includes(fromType) || !spec.to.includes(toType)) {
          return fail('schema', `edge '${f.type}' does not allow ${fromType} -> ${toType}`);
        }
        const bad = checkAttrs(spec.attrs, f.attrs ?? {}, `edge '${f.type}'`);
        if (bad) return fail('schema', bad);
      }
      pending.push(() => {
        const id = this.newId('r');
        this.db
          .prepare(
            `INSERT INTO edges (id, world, type, from_id, to_id, attrs_json, valid_from, recorded_at,
               source_ref, author, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            world,
            f.type,
            f.fromId,
            f.toId,
            JSON.stringify(f.attrs ?? {}),
            f.validFrom ?? null,
            at,
            f.sourceRef,
            f.author,
            f.confidence,
          );
        return id;
      });
    }
    const ids = this.db.transaction(() => pending.map((run) => run()))();
    return { ok: true, ids };
  }

  /**
   * Sets valid_to once and stores the closer's `author` and `sourceRef` in the
   * same UPDATE (closed_by, closed_source_ref), so `changes` names the closer.
   * Set-once is enforced by the `*_no_rewrite` triggers in schema.ts, pinned by
   * 'R3 closer and retirer columns are set once' in graph-store.test.ts.
   */
  async close(
    world: WorldId,
    factId: string,
    validTo: string,
    sourceRef: string,
    author: FactAuthor,
  ): Promise<WriteResult> {
    if (!isIso(validTo))
      return { ok: false, code: 'invalid', reason: `'${validTo}' is not a date` };
    const found = this.findFact(world, factId);
    if (!found) return { ok: false, code: 'not_found', reason: `fact ${factId} not found` };
    if (found.retired_at !== null) {
      return { ok: false, code: 'closed', reason: `fact ${factId} is retired` };
    }
    if (found.valid_to !== null) {
      return { ok: false, code: 'closed', reason: `fact ${factId} is already closed` };
    }
    if (found.valid_from !== null && validTo < found.valid_from) {
      return { ok: false, code: 'invalid', reason: 'validTo is before validFrom' };
    }
    this.db
      .prepare(
        `UPDATE ${found.table} SET valid_to = ?, closed_by = ?, closed_source_ref = ?
         WHERE id = ? AND valid_to IS NULL`,
      )
      .run(validTo, author, sourceRef, factId);
    return { ok: true, ids: [factId] };
  }

  /**
   * Sets retired_at once (the Ethos-clock "this was wrong") and stores the
   * retirer in retired_by / retired_source_ref. See `close` for the guard.
   */
  async retire(
    world: WorldId,
    factId: string,
    sourceRef: string,
    author: FactAuthor,
  ): Promise<WriteResult> {
    const found = this.findFact(world, factId);
    if (!found) return { ok: false, code: 'not_found', reason: `fact ${factId} not found` };
    if (found.retired_at !== null) {
      return { ok: false, code: 'closed', reason: `fact ${factId} is already retired` };
    }
    this.db
      .prepare(
        `UPDATE ${found.table} SET retired_at = ?, retired_by = ?, retired_source_ref = ?
         WHERE id = ? AND retired_at IS NULL`,
      )
      .run(this.nowIso(), author, sourceRef, factId);
    return { ok: true, ids: [factId] };
  }

  private findFact(
    world: WorldId,
    factId: string,
  ): {
    table: 'attributes' | 'edges';
    valid_from: string | null;
    valid_to: string | null;
    retired_at: string | null;
  } | null {
    for (const table of ['attributes', 'edges'] as const) {
      const row = this.db
        .prepare(`SELECT valid_from, valid_to, retired_at FROM ${table} WHERE world = ? AND id = ?`)
        .get(world, factId) as
        | { valid_from: string | null; valid_to: string | null; retired_at: string | null }
        | undefined;
      if (row) return { table, ...row };
    }
    return null;
  }

  async import(world: WorldId, data: GraphBundle): Promise<ImportReport> {
    const report: ImportReport = { entities: 0, attributes: 0, edges: 0, skipped: [] };
    const schema = await this.getSchema(world);
    const typeById = new Map<string, string>();
    for (const r of this.db
      .prepare('SELECT id, type FROM entities WHERE world = ?')
      .all(world) as Array<{ id: string; type: string }>) {
      typeById.set(r.id, r.type);
    }
    let line = 0;
    const skip = (reason: string) => report.skipped.push({ line, reason });
    const exists = (table: string, id: string): boolean =>
      this.db.prepare(`SELECT 1 AS x FROM ${table} WHERE id = ?`).get(id) !== undefined;

    this.db.transaction(() => {
      for (const e of data.entities) {
        line++;
        if (typeById.has(e.id) || exists('entities', e.id)) {
          skip(`duplicate entity id ${e.id}`);
          continue;
        }
        if (schema && !schema.entities[e.type]) {
          skip(`entity type '${e.type}' is not in the schema`);
          continue;
        }
        this.db
          .prepare(
            `INSERT INTO entities (id, world, type, name, aliases, recorded_at, retired_at, merged_into, source_ref, author)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            e.id,
            world,
            e.type,
            e.name,
            JSON.stringify(e.aliases),
            e.recordedAt,
            e.retiredAt,
            e.mergedInto,
            e.sourceRef,
            e.author,
          );
        typeById.set(e.id, e.type);
        report.entities++;
      }
      for (const a of data.attributes) {
        line++;
        const type = typeById.get(a.entityId);
        if (type === undefined) {
          skip(`attribute ${a.id}: entity ${a.entityId} not found`);
          continue;
        }
        if (exists('attributes', a.id)) {
          skip(`duplicate attribute id ${a.id}`);
          continue;
        }
        if (schema) {
          const spec = schema.entities[type]?.attrs[a.key];
          const bad = spec ? checkAttr(spec, a.value) : 'is not in the schema';
          if (bad) {
            skip(`attribute ${a.id}: ${type}.${a.key} ${bad}`);
            continue;
          }
        }
        this.db
          .prepare(
            `INSERT INTO attributes (id, world, entity_id, key, value_json, valid_from, valid_to, recorded_at,
               retired_at, source_ref, author, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            a.id,
            world,
            a.entityId,
            a.key,
            JSON.stringify(a.value ?? null),
            a.validFrom,
            a.validTo,
            a.recordedAt,
            a.retiredAt,
            a.sourceRef,
            a.author,
            a.confidence,
          );
        report.attributes++;
      }
      for (const r of data.edges) {
        line++;
        const fromType = typeById.get(r.fromId);
        const toType = typeById.get(r.toId);
        if (fromType === undefined || toType === undefined) {
          skip(`edge ${r.id}: endpoint not found`);
          continue;
        }
        if (exists('edges', r.id)) {
          skip(`duplicate edge id ${r.id}`);
          continue;
        }
        if (schema) {
          const spec = schema.edges[r.type];
          if (!spec?.from.includes(fromType) || !spec.to.includes(toType)) {
            skip(`edge ${r.id}: '${r.type}' ${fromType} -> ${toType} is not in the schema`);
            continue;
          }
        }
        this.db
          .prepare(
            `INSERT INTO edges (id, world, type, from_id, to_id, attrs_json, valid_from, valid_to, recorded_at,
               retired_at, source_ref, author, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            r.id,
            world,
            r.type,
            r.fromId,
            r.toId,
            JSON.stringify(r.attrs),
            r.validFrom,
            r.validTo,
            r.recordedAt,
            r.retiredAt,
            r.sourceRef,
            r.author,
            r.confidence,
          );
        report.edges++;
      }
    })();
    return report;
  }

  // ---- reads ----------------------------------------------------------------

  /** `[sql, params]` for the two-clock slice on attributes or edges. Defaults: now, now. */
  protected sliceClause(slice?: TimeSlice): [string, string[]] {
    const now = this.nowIso();
    const asOf = slice?.asOf ?? now;
    const knownAt = slice?.knownAt ?? now;
    return [`${WORLD_SQL} AND ${KNOWN_SQL}`, [asOf, asOf, knownAt, knownAt]];
  }

  async query(world: WorldId, q: GraphQuery, slice?: TimeSlice): Promise<Facts> {
    if (q.kind === 'entities') return this.queryEntities(world, q, slice);
    if (q.kind === 'edges') return this.queryEdges(world, q, slice);
    return this.queryPaths(world, q, slice);
  }

  private queryPaths(
    world: WorldId,
    q: Extract<GraphQuery, { kind: 'paths' }>,
    slice?: TimeSlice,
  ): Facts {
    const knownAt = slice?.knownAt ?? this.nowIso();
    const [sql, sliceParams] = this.sliceClause(slice);
    const maxHops = Math.min(Math.max(0, Math.floor(q.maxHops)), MAX_HOPS);
    const found = walkPaths(
      this.db,
      world,
      q.fromId,
      q.via,
      maxHops,
      q.toType,
      knownAt,
      sql,
      sliceParams,
      q.limit + 1,
    );
    const truncated = found.length > q.limit;
    const paths = found.slice(0, q.limit);
    const entities = this.entitiesByIds(world, [...new Set(paths.flat())], slice);
    return { entities, attributes: [], edges: [], paths, truncated };
  }

  async neighbours(
    world: WorldId,
    entityId: string,
    hops: number,
    slice?: TimeSlice,
  ): Promise<Subgraph> {
    const depth = Math.min(Math.max(0, Math.floor(hops)), this.capabilities().maxHops);
    const [sql, sliceParams] = this.sliceClause(slice);
    const walk = walkNeighbours(this.db, world, entityId, depth, sql, sliceParams);
    const visible = this.entitiesByIds(
      world,
      walk.nodes.map((n) => n.id),
      slice,
    );
    const rank = new Map(walk.nodes.map((n, i) => [n.id, i]));
    visible.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    const truncated = visible.length > NEIGHBOUR_LIMIT;
    const entities = visible.slice(0, NEIGHBOUR_LIMIT);
    const kept = new Set(entities.map((e) => e.id));
    const edges =
      walk.edgeRowids.length === 0
        ? []
        : (
            this.db
              .prepare(
                `SELECT ${EDGE_COLS} FROM edges WHERE world = ? AND rowid IN (${placeholders(walk.edgeRowids.length)})
                 ORDER BY recorded_at, rowid`,
              )
              .all(world, ...walk.edgeRowids) as EdgeRow[]
          )
            .map((r) => this.toEdge(r))
            .filter((e) => kept.has(e.fromId) && kept.has(e.toId));
    return {
      centre: entityId,
      hops: depth,
      entities,
      attributes: this.liveAttributes(world, [...kept], slice),
      edges,
      truncated,
    };
  }

  private queryEntities(
    world: WorldId,
    q: Extract<GraphQuery, { kind: 'entities' }>,
    slice?: TimeSlice,
  ): Facts {
    const knownAt = slice?.knownAt ?? this.nowIso();
    const where = ['world = ?', KNOWN_SQL];
    const params: Array<string | number> = [world, knownAt, knownAt];
    if (q.types && q.types.length > 0) {
      where.push(`type IN (${placeholders(q.types.length)})`);
      params.push(...q.types);
    }
    let rows: EntityRow[];
    if (q.text !== undefined && toMatchQuery(q.text) !== null) {
      // Best match first; the rowid list is already filtered to this world and slice.
      const rowids = searchEntityRowids(this.db, world, q.text, q.types, knownAt, q.limit + 1);
      rows =
        rowids.length === 0
          ? []
          : (this.db
              .prepare(
                `SELECT ${ENTITY_COLS} FROM entities WHERE rowid IN (${placeholders(rowids.length)})`,
              )
              .all(...rowids) as EntityRow[]);
      const order = new Map(rowids.map((rid, i) => [rid, i]));
      rows.sort((a, b) => (order.get(a.rowid) ?? 0) - (order.get(b.rowid) ?? 0));
    } else {
      rows = this.db
        .prepare(
          `SELECT ${ENTITY_COLS} FROM entities WHERE ${where.join(' AND ')} ORDER BY recorded_at, rowid LIMIT ?`,
        )
        .all(...params, q.limit + 1) as EntityRow[];
    }
    const truncated = rows.length > q.limit;
    const entities = rows.slice(0, q.limit).map((r) => this.toEntity(r));
    return {
      entities,
      attributes: this.liveAttributes(
        world,
        entities.map((e) => e.id),
        slice,
      ),
      edges: [],
      truncated,
    };
  }

  private queryEdges(
    world: WorldId,
    q: Extract<GraphQuery, { kind: 'edges' }>,
    slice?: TimeSlice,
  ): Facts {
    const knownAt = slice?.knownAt ?? this.nowIso();
    const asOf = slice?.asOf ?? this.nowIso();
    const where = ['world = ?', KNOWN_SQL];
    const params: Array<string | number> = [world, knownAt, knownAt];
    if (!q.includeClosed) {
      where.push(WORLD_SQL);
      params.push(asOf, asOf);
    }
    if (q.fromId !== undefined) {
      where.push('from_id = ?');
      params.push(q.fromId);
    }
    if (q.toId !== undefined) {
      where.push('to_id = ?');
      params.push(q.toId);
    }
    if (q.types && q.types.length > 0) {
      where.push(`type IN (${placeholders(q.types.length)})`);
      params.push(...q.types);
    }
    const rows = this.db
      .prepare(
        `SELECT ${EDGE_COLS} FROM edges WHERE ${where.join(' AND ')} ORDER BY recorded_at, rowid LIMIT ?`,
      )
      .all(...params, q.limit + 1) as EdgeRow[];
    const truncated = rows.length > q.limit;
    const edges = rows.slice(0, q.limit).map((r) => this.toEdge(r));
    const ids = [...new Set(edges.flatMap((e) => [e.fromId, e.toId]))];
    return { entities: this.entitiesByIds(world, ids, slice), attributes: [], edges, truncated };
  }

  /** Entities by id in the Ethos-clock slice, in insertion order. */
  protected entitiesByIds(world: WorldId, ids: string[], slice?: TimeSlice): Entity[] {
    if (ids.length === 0) return [];
    const knownAt = slice?.knownAt ?? this.nowIso();
    const rows = this.db
      .prepare(
        `SELECT ${ENTITY_COLS} FROM entities WHERE world = ? AND ${KNOWN_SQL}
         AND id IN (${placeholders(ids.length)}) ORDER BY recorded_at, rowid`,
      )
      .all(world, knownAt, knownAt, ...ids) as EntityRow[];
    return rows.map((r) => this.toEntity(r));
  }

  /** Attributes of the given entities that hold in the slice, in insertion order. */
  protected liveAttributes(
    world: WorldId,
    entityIds: string[],
    slice?: TimeSlice,
  ): AttributeFact[] {
    if (entityIds.length === 0) return [];
    const [sql, sliceParams] = this.sliceClause(slice);
    const rows = this.db
      .prepare(
        `SELECT ${ATTRIBUTE_COLS} FROM attributes WHERE world = ? AND ${sql}
         AND entity_id IN (${placeholders(entityIds.length)}) ORDER BY recorded_at, rowid`,
      )
      .all(world, ...sliceParams, ...entityIds) as AttributeRow[];
    return rows.map((r) => this.toAttribute(r));
  }

  /** Every attribute and edge of one entity, closed and retired included. */
  async history(
    world: WorldId,
    entityId: string,
  ): Promise<{ attributes: AttributeFact[]; edges: Edge[] }> {
    const attributes = this.db
      .prepare(
        `SELECT ${ATTRIBUTE_COLS} FROM attributes WHERE world = ? AND entity_id = ? ORDER BY recorded_at, rowid`,
      )
      .all(world, entityId) as AttributeRow[];
    const edges = this.db
      .prepare(
        `SELECT ${EDGE_COLS} FROM edges WHERE world = ? AND (from_id = ? OR to_id = ?) ORDER BY recorded_at, rowid`,
      )
      .all(world, entityId, entityId) as EdgeRow[];
    return {
      attributes: attributes.map((r) => this.toAttribute(r)),
      edges: edges.map((r) => this.toEdge(r)),
    };
  }

  /** Changes with `at >= since`, oldest first. */
  async changes(world: WorldId, since: string, limit: number): Promise<ChangeRow[]> {
    const parts: string[] = [];
    const params: Array<string | number> = [];
    const add = (sql: string): void => {
      parts.push(sql);
      params.push(world, since);
    };
    add(`SELECT recorded_at AS at, 'entity' AS kind, id AS fact_id, source_ref, author, 0 AS rank, rowid AS rid
         FROM entities WHERE world = ? AND recorded_at >= ?`);
    for (const t of ['attributes', 'edges']) {
      add(`SELECT recorded_at AS at, 'opened' AS kind, id AS fact_id, source_ref, author, 1 AS rank, rowid AS rid
           FROM ${t} WHERE world = ? AND recorded_at >= ?`);
      // 'closed' and 'retired' name the closer / retirer. A row with NULL closer
      // columns (closed through `import` with valid_to already set) falls back
      // to the fact's own source_ref and author.
      add(`SELECT valid_to AS at, 'closed' AS kind, id AS fact_id,
             COALESCE(closed_source_ref, source_ref) AS source_ref, COALESCE(closed_by, author) AS author,
             2 AS rank, rowid AS rid
           FROM ${t} WHERE world = ? AND valid_to IS NOT NULL AND valid_to >= ?`);
      add(`SELECT retired_at AS at, 'retired' AS kind, id AS fact_id,
             COALESCE(retired_source_ref, source_ref) AS source_ref, COALESCE(retired_by, author) AS author,
             3 AS rank, rowid AS rid
           FROM ${t} WHERE world = ? AND retired_at IS NOT NULL AND retired_at >= ?`);
    }
    const rows = this.db
      .prepare(`${parts.join(' UNION ALL ')} ORDER BY at, rank, rid LIMIT ?`)
      .all(...params, limit) as Array<{
      at: string;
      kind: ChangeRow['kind'];
      fact_id: string;
      source_ref: string;
      author: FactAuthor;
    }>;
    return rows.map((r) => ({
      at: r.at,
      kind: r.kind,
      factId: r.fact_id,
      sourceRef: r.source_ref,
      author: r.author,
    }));
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
