import type Database from '@ethosagent/sqlite';

// FTS5 over entity names and aliases (plan world-model Task 1.4). External
// content over `entities`, kept in step by triggers, the session-sqlite
// `messages_fts` precedent. FTS5 virtual tables cannot be STRICT; the shadow
// tables FTS5 creates are exempt from 'tables are STRICT' by name.
//
// The external-content index is keyed by `entities.rowid`, which is stable as
// long as the file is never VACUUMed (same caveat as messages_fts).

export const FTS_TABLE = 'entity_names_fts';

export const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
  name, aliases, content='entities', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS entity_fts_ai AFTER INSERT ON entities BEGIN
  INSERT INTO ${FTS_TABLE}(rowid, name, aliases) VALUES (new.rowid, new.name, new.aliases);
END;
CREATE TRIGGER IF NOT EXISTS entity_fts_ad AFTER DELETE ON entities BEGIN
  INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, name, aliases)
    VALUES ('delete', old.rowid, old.name, old.aliases);
END;
CREATE TRIGGER IF NOT EXISTS entity_fts_au AFTER UPDATE OF name, aliases ON entities BEGIN
  INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, name, aliases)
    VALUES ('delete', old.rowid, old.name, old.aliases);
  INSERT INTO ${FTS_TABLE}(rowid, name, aliases) VALUES (new.rowid, new.name, new.aliases);
END;
`;

/**
 * Every whitespace-separated token becomes one quoted FTS5 string (an embedded
 * `"` doubled) with a prefix star, so `OR`, `NEAR(`, `*`, `name:` and friends
 * in user text are literal words, never syntax. Returns null when nothing is
 * left to search for. Pinned by search.test.ts 'FTS operators in text are inert'.
 */
export function toMatchQuery(text: string): string | null {
  const tokens = text
    .split(/\s+/)
    .filter((t) => t !== '')
    .map((t) => `"${t.replaceAll('"', '""')}"*`);
  return tokens.length === 0 ? null : tokens.join(' ');
}

/** Ranked entity rowids for `text` in one world (best match first, rowid tie-break). */
export function searchEntityRowids(
  db: Database.Database,
  world: string,
  text: string,
  types: string[] | undefined,
  knownAt: string,
  limit: number,
): number[] {
  const match = toMatchQuery(text);
  if (match === null) return [];
  const where = ['e.world = ?', 'e.recorded_at <= ?', '(e.retired_at IS NULL OR e.retired_at > ?)'];
  const params: Array<string | number> = [match, world, knownAt, knownAt];
  if (types && types.length > 0) {
    where.push(`e.type IN (${types.map(() => '?').join(', ')})`);
    params.push(...types);
  }
  const rows = db
    .prepare(
      `SELECT e.rowid AS rid FROM ${FTS_TABLE} f JOIN entities e ON e.rowid = f.rowid
       WHERE ${FTS_TABLE} MATCH ? AND ${where.join(' AND ')}
       ORDER BY f.rank, e.rowid LIMIT ?`,
    )
    .all(...params, limit) as Array<{ rid: number }>;
  return rows.map((r) => r.rid);
}
