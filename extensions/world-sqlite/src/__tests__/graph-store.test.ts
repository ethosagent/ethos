import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from '@ethosagent/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteWorldGraphProvider, worldGraphDbPath } from '../index';

const W = 'world:acme' as const;
const T = '2026-11-20T00:00:00.000Z';

function rawDb(store: unknown): Database.Database {
  return (store as { db: Database.Database }).db;
}

function insertEntity(db: Database.Database, id: string, world: string = W): void {
  db.prepare(
    `INSERT INTO entities (id, world, type, name, recorded_at, source_ref, author)
     VALUES (?, ?, 'Person', ?, ?, 'test', 'user')`,
  ).run(id, world, id, T);
}

function insertEdge(
  db: Database.Database,
  id: string,
  from: string,
  to: string,
  recordedAt = T,
  world: string = W,
): void {
  db.prepare(
    `INSERT INTO edges (id, world, type, from_id, to_id, recorded_at, source_ref, author, confidence)
     VALUES (?, ?, 'owns', ?, ?, ?, 'test', 'user', 1)`,
  ).run(id, world, from, to, recordedAt);
}

describe('SQLiteWorldGraphProvider — store', () => {
  let dir: string;
  let store: SQLiteWorldGraphProvider;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'world-sqlite-'));
    store = new SQLiteWorldGraphProvider(worldGraphDbPath(dir));
  });
  afterEach(() => {
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('worldGraphDbPath puts the database under worlds/', () => {
    expect(worldGraphDbPath('/data')).toBe(join('/data', 'worlds', 'graph.db'));
  });

  it('tables are STRICT', () => {
    // FTS5 cannot be STRICT: its virtual table and the shadow tables it
    // creates (entity_names_fts_*) are the one exception (session-sqlite precedent).
    const rows = rawDb(store)
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'entity_names_fts%'`,
      )
      .all() as Array<{ name: string; sql: string }>;
    expect(rows.map((r) => r.name).sort()).toEqual(
      ['attributes', 'edges', 'entities', 'purge_tokens', 'schemas'].sort(),
    );
    for (const r of rows) {
      expect(r.sql.trimEnd().endsWith('STRICT'), `${r.name} is not STRICT`).toBe(true);
    }
    const fts = rawDb(store)
      .prepare(`SELECT sql FROM sqlite_master WHERE name = 'entity_names_fts'`)
      .get() as { sql: string };
    expect(fts.sql).toContain('VIRTUAL TABLE');
  });

  it('durability posture is FULL', () => {
    // graph.db is the source of truth for user-entered facts and nothing
    // rebuilds it (.claude/rules/sqlite-durability.md): never sweep to NORMAL.
    const sync = rawDb(store).pragma('synchronous') as Array<{ synchronous: number }>;
    expect(sync[0]?.synchronous).toBe(2);
    const mode = rawDb(store).pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(mode[0]?.journal_mode).toBe('wal');
  });

  it('ids are e-/a-/r- plus 16 hex', () => {
    expect(store.newId('e')).toMatch(/^e-[0-9a-f]{16}$/);
    expect(store.newId('a')).toMatch(/^a-[0-9a-f]{16}$/);
    expect(store.newId('r')).toMatch(/^r-[0-9a-f]{16}$/);
    expect(store.newId('e')).not.toBe(store.newId('e'));
  });

  it('R3 facts are closed, never deleted', () => {
    const db = rawDb(store);
    insertEntity(db, 'e-a');
    insertEntity(db, 'e-b');
    insertEdge(db, 'r-1', 'e-a', 'e-b');

    expect(() => db.prepare('DELETE FROM edges').run()).toThrow(/never deleted/);
    expect(() => db.prepare(`UPDATE edges SET to_id = 'e-a' WHERE id = 'r-1'`).run()).toThrow(
      /never rewritten/,
    );
    // close once: fine; a second time: refused.
    db.prepare(`UPDATE edges SET valid_to = ? WHERE id = 'r-1'`).run('2026-11-21T00:00:00.000Z');
    expect(() =>
      db.prepare(`UPDATE edges SET valid_to = ? WHERE id = 'r-1'`).run('2026-11-22T00:00:00.000Z'),
    ).toThrow(/never rewritten/);
    // retire once: fine; a second time: refused.
    db.prepare(`UPDATE edges SET retired_at = ? WHERE id = 'r-1'`).run('2026-11-21T00:00:00.000Z');
    expect(() =>
      db
        .prepare(`UPDATE edges SET retired_at = ? WHERE id = 'r-1'`)
        .run('2026-11-22T00:00:00.000Z'),
    ).toThrow(/never rewritten/);
  });

  it('R3 closer and retirer columns are set once, with the close or retire, and never rewritten', () => {
    const db = rawDb(store);
    insertEntity(db, 'e-a');
    insertEntity(db, 'e-b');
    insertEdge(db, 'r-1', 'e-a', 'e-b');

    // Not on a live fact: closer columns alone, without closing, are refused.
    expect(() =>
      db
        .prepare(`UPDATE edges SET closed_by = 'agent', closed_source_ref = 'x' WHERE id = 'r-1'`)
        .run(),
    ).toThrow(/never rewritten/);
    expect(() =>
      db
        .prepare(`UPDATE edges SET retired_by = 'agent', retired_source_ref = 'x' WHERE id = 'r-1'`)
        .run(),
    ).toThrow(/never rewritten/);
    // An author outside the enum is refused.
    expect(() =>
      db
        .prepare(
          `UPDATE edges SET valid_to = ?, closed_by = 'root', closed_source_ref = 'x' WHERE id = 'r-1'`,
        )
        .run('2026-11-21T00:00:00.000Z'),
    ).toThrow();

    // With the first close: allowed. Afterwards: frozen.
    db.prepare(
      `UPDATE edges SET valid_to = ?, closed_by = 'agent', closed_source_ref = 'x' WHERE id = 'r-1'`,
    ).run('2026-11-21T00:00:00.000Z');
    expect(() => db.prepare(`UPDATE edges SET closed_by = 'user' WHERE id = 'r-1'`).run()).toThrow(
      /never rewritten/,
    );
    expect(() =>
      db.prepare(`UPDATE edges SET closed_source_ref = 'y' WHERE id = 'r-1'`).run(),
    ).toThrow(/never rewritten/);
    // The retirer is independent of the closer: set with the first retire only.
    db.prepare(
      `UPDATE edges SET retired_at = ?, retired_by = 'user', retired_source_ref = 'z' WHERE id = 'r-1'`,
    ).run('2026-11-22T00:00:00.000Z');
    expect(() =>
      db.prepare(`UPDATE edges SET retired_source_ref = 'w' WHERE id = 'r-1'`).run(),
    ).toThrow(/never rewritten/);
    expect(() =>
      db.prepare(`UPDATE edges SET retired_by = 'agent' WHERE id = 'r-1'`).run(),
    ).toThrow(/never rewritten/);

    // A fact closed without a closer (an import) cannot gain one later.
    insertEdge(db, 'r-2', 'e-a', 'e-b');
    db.prepare(`UPDATE edges SET valid_to = ? WHERE id = 'r-2'`).run('2026-11-21T00:00:00.000Z');
    expect(() =>
      db
        .prepare(`UPDATE edges SET closed_by = 'user', closed_source_ref = 'late' WHERE id = 'r-2'`)
        .run(),
    ).toThrow(/never rewritten/);

    // Attributes carry the same columns and the same guard.
    insertEntity(db, 'e-c');
    db.prepare(
      `INSERT INTO attributes (id, world, entity_id, key, value_json, recorded_at, source_ref, author, confidence)
       VALUES ('a-9', ?, 'e-c', 'location', '"Pune"', ?, 'test', 'user', 1)`,
    ).run(W, T);
    expect(() =>
      db
        .prepare(
          `UPDATE attributes SET closed_by = 'agent', closed_source_ref = 'x' WHERE id = 'a-9'`,
        )
        .run(),
    ).toThrow(/never rewritten/);
    db.prepare(
      `UPDATE attributes SET valid_to = ?, closed_by = 'agent', closed_source_ref = 'x' WHERE id = 'a-9'`,
    ).run(T);
    expect(() =>
      db.prepare(`UPDATE attributes SET closed_by = 'user' WHERE id = 'a-9'`).run(),
    ).toThrow(/never rewritten/);
  });

  it('R3 entity retirer columns are set once, with the retire, and never rewritten', () => {
    const db = rawDb(store);
    insertEntity(db, 'e-a');
    // Not on a live entity: retirer columns alone are refused.
    expect(() =>
      db
        .prepare(
          `UPDATE entities SET retired_by = 'agent', retired_source_ref = 'x' WHERE id = 'e-a'`,
        )
        .run(),
    ).toThrow(/never rewritten/);
    // An author outside the enum is refused.
    expect(() =>
      db.prepare(`UPDATE entities SET retired_at = ?, retired_by = 'root' WHERE id = 'e-a'`).run(T),
    ).toThrow();
    db.prepare(
      `UPDATE entities SET retired_at = ?, retired_by = 'agent', retired_source_ref = 'schema:v2' WHERE id = 'e-a'`,
    ).run(T);
    expect(() =>
      db.prepare(`UPDATE entities SET retired_by = 'user' WHERE id = 'e-a'`).run(),
    ).toThrow(/never rewritten/);
    expect(() =>
      db.prepare(`UPDATE entities SET retired_source_ref = 'y' WHERE id = 'e-a'`).run(),
    ).toThrow(/never rewritten/);
    // An entity retired without a retirer (an import) never gains one.
    insertEntity(db, 'e-b');
    db.prepare(`UPDATE entities SET retired_at = ? WHERE id = 'e-b'`).run(T);
    expect(() =>
      db
        .prepare(
          `UPDATE entities SET retired_by = 'user', retired_source_ref = 'late' WHERE id = 'e-b'`,
        )
        .run(),
    ).toThrow(/never rewritten/);
  });

  it('R3 attributes get the same triggers, entities allow only alias appends, merge and retire', () => {
    const db = rawDb(store);
    insertEntity(db, 'e-a');
    db.prepare(
      `INSERT INTO attributes (id, world, entity_id, key, value_json, recorded_at, source_ref, author, confidence)
       VALUES ('a-1', ?, 'e-a', 'location', '"Pune"', ?, 'test', 'user', 1)`,
    ).run(W, T);

    expect(() => db.prepare('DELETE FROM attributes').run()).toThrow(/never deleted/);
    expect(() =>
      db.prepare(`UPDATE attributes SET value_json = '"Delhi"' WHERE id = 'a-1'`).run(),
    ).toThrow(/never rewritten/);
    db.prepare(`UPDATE attributes SET valid_to = ? WHERE id = 'a-1'`).run(T);
    expect(() =>
      db.prepare(`UPDATE attributes SET valid_to = ? WHERE id = 'a-1'`).run('2026-12-01T00:00:00Z'),
    ).toThrow(/never rewritten/);

    expect(() => db.prepare('DELETE FROM entities').run()).toThrow(/never deleted/);
    expect(() => db.prepare(`UPDATE entities SET name = 'x' WHERE id = 'e-a'`).run()).toThrow(
      /never rewritten/,
    );
    db.prepare(`UPDATE entities SET aliases = '["p@acme.example"]' WHERE id = 'e-a'`).run();
    db.prepare(`UPDATE entities SET aliases = '["p@acme.example","pri"]' WHERE id = 'e-a'`).run();
    expect(() =>
      db.prepare(`UPDATE entities SET aliases = '["pri"]' WHERE id = 'e-a'`).run(),
    ).toThrow(/never rewritten/);
    expect(() =>
      db.prepare(`UPDATE entities SET aliases = '["other","pri"]' WHERE id = 'e-a'`).run(),
    ).toThrow(/never rewritten/);
    db.prepare(`UPDATE entities SET merged_into = 'e-z', retired_at = ? WHERE id = 'e-a'`).run(T);
    expect(() =>
      db.prepare(`UPDATE entities SET retired_at = '2027-01-01' WHERE id = 'e-a'`).run(),
    ).toThrow(/never rewritten/);
  });

  it('purge removes rows only with a token, in one transaction', async () => {
    const db = rawDb(store);
    insertEntity(db, 'e-a');
    insertEntity(db, 'e-b');
    insertEntity(db, 'e-c');
    insertEdge(db, 'r-1', 'e-a', 'e-b');
    insertEdge(db, 'r-2', 'e-b', 'e-c');
    // a second world is untouched by a purge of the first
    insertEntity(db, 'e-x', 'world:other');
    insertEntity(db, 'e-y', 'world:other');
    insertEdge(db, 'r-9', 'e-x', 'e-y', T, 'world:other');

    // No token: refused.
    expect(() => db.prepare(`DELETE FROM edges WHERE id = 'r-1'`).run()).toThrow(/never deleted/);

    // Atomicity: a failure mid-purge rolls the token and the deletes back.
    db.exec(`CREATE TRIGGER boom BEFORE DELETE ON entities BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    await expect(store.purge(W, { entityId: 'e-b' }, 'test')).rejects.toThrow(/boom/);
    expect(db.prepare('SELECT count(*) AS n FROM edges').get()).toEqual({ n: 3 });
    expect(db.prepare('SELECT count(*) AS n FROM purge_tokens').get()).toEqual({ n: 0 });
    db.exec('DROP TRIGGER boom');

    // Entity-scoped purge removes the entity, its attributes and every edge touching it.
    const one = await store.purge(W, { entityId: 'e-b' }, 'user asked');
    expect(one.removed).toBe(3); // e-b plus r-1 and r-2
    expect(db.prepare(`SELECT id FROM entities WHERE world = ? ORDER BY rowid`).all(W)).toEqual([
      { id: 'e-a' },
      { id: 'e-c' },
    ]);
    // The token does not outlive the transaction.
    expect(db.prepare('SELECT count(*) AS n FROM purge_tokens').get()).toEqual({ n: 0 });
    expect(() => db.prepare(`DELETE FROM entities WHERE id = 'e-a'`).run()).toThrow(
      /never deleted/,
    );

    // World-scoped purge leaves other worlds alone.
    const all = await store.purge(W, {}, 'wipe');
    expect(all.removed).toBe(2);
    expect(db.prepare('SELECT count(*) AS n FROM entities').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT count(*) AS n FROM edges').get()).toEqual({ n: 1 });
  });

  it('ordered reads tie-break on rowid', async () => {
    const db = rawDb(store);
    insertEntity(db, 'e-a');
    insertEntity(db, 'e-b');
    // Same recorded_at, ids sorted opposite to insertion order.
    insertEdge(db, 'r-z', 'e-a', 'e-b', T);
    insertEdge(db, 'r-m', 'e-b', 'e-a', T);
    insertEdge(db, 'r-a', 'e-a', 'e-b', T);
    const bundle = await store.export(W);
    expect(bundle.edges.map((e) => e.id)).toEqual(['r-z', 'r-m', 'r-a']);
  });

  it('getSchema / applySchema round-trip and parse the stored row', async () => {
    expect(await store.getSchema(W)).toBeNull();
    const schema = {
      version: 1,
      entities: { Person: { attrs: { location: { type: 'string' as const } } } },
      edges: { owns: { from: ['Person'], to: ['Person'], attrs: {} } },
    };
    expect(await store.applySchema(W, schema)).toEqual({ ok: true, ids: [] });
    expect(await store.getSchema(W)).toEqual(schema);
    expect(await store.getSchema('world:other')).toBeNull();
    const bad = await store.applySchema(W, { ...schema, version: 0 });
    expect(bad.ok).toBe(false);
  });

  it('capabilities are bitemporal, full-text, no vector, three hops', () => {
    expect(store.capabilities()).toEqual({
      bitemporal: true,
      fullText: true,
      vector: false,
      maxHops: 3,
    });
  });
});
