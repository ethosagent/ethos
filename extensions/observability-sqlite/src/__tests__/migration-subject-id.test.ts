// Verifies the idempotent personality_id → subject_id column rename in
// SQLiteObservabilityStore.constructor → migrate(). When opening an
// existing database created before the rename, the column is renamed
// in place; opening a fresh DB uses the new schema directly.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteObservabilityStore } from '../store';

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obs-mig-'));
  dbPath = join(tmp, 'observability.db');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function columnNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

describe('SQLiteObservabilityStore migration: personality_id → subject_id', () => {
  it('renames the column on traces and snapshots when opening a legacy DB', () => {
    // Seed an old-schema DB with the legacy column name and a row that
    // must survive the rename intact.
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE traces (
        trace_id        TEXT PRIMARY KEY,
        session_id      TEXT,
        kind            TEXT NOT NULL,
        start_ts        INTEGER NOT NULL,
        end_ts          INTEGER,
        status          TEXT,
        personality_id  TEXT,
        snapshot_id     TEXT,
        attrs           TEXT
      ) STRICT;
      CREATE TABLE snapshots (
        snapshot_id     TEXT PRIMARY KEY,
        taken_at        INTEGER NOT NULL,
        personality_id  TEXT NOT NULL,
        body            TEXT NOT NULL
      ) STRICT;
    `);
    seed
      .prepare('INSERT INTO traces (trace_id, kind, start_ts, personality_id) VALUES (?, ?, ?, ?)')
      .run('t1', 'turn', 100, 'engineer');
    seed
      .prepare(
        'INSERT INTO snapshots (snapshot_id, taken_at, personality_id, body) VALUES (?, ?, ?, ?)',
      )
      .run('s1', 100, 'engineer', '{}');
    seed.close();

    // Open via the store — migrate() must rename in place.
    const store = new SQLiteObservabilityStore(dbPath);
    store.close();

    const verify = new Database(dbPath);
    try {
      const tCols = columnNames(verify, 'traces');
      const sCols = columnNames(verify, 'snapshots');
      expect(tCols.has('subject_id')).toBe(true);
      expect(tCols.has('personality_id')).toBe(false);
      expect(sCols.has('subject_id')).toBe(true);
      expect(sCols.has('personality_id')).toBe(false);

      // Pre-existing row data still queryable under the new column name.
      const t = verify.prepare('SELECT subject_id FROM traces WHERE trace_id = ?').get('t1') as {
        subject_id: string;
      };
      expect(t.subject_id).toBe('engineer');
      const s = verify
        .prepare('SELECT subject_id FROM snapshots WHERE snapshot_id = ?')
        .get('s1') as { subject_id: string };
      expect(s.subject_id).toBe('engineer');
    } finally {
      verify.close();
    }
  });

  it('is idempotent — re-opening after migration is a no-op', () => {
    const a = new SQLiteObservabilityStore(dbPath);
    a.close();
    expect(() => {
      const b = new SQLiteObservabilityStore(dbPath);
      b.close();
    }).not.toThrow();
  });
});
