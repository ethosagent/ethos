// Health probes for the `messages_fts` external-content index, on a raw handle.
//
// Functions only, no class and no migration: diagnostics never migrate a store
// (pinned by apps/ethos/src/commands/__tests__/diagnostics-never-migrate.test.ts)
// and every caller opens `sessions.db` as a raw `@ethosagent/sqlite` Database.

import type Database from '@ethosagent/sqlite';

export interface FtsProbe {
  /** `SELECT count(*) FROM messages`. */
  messages: number;
  /** `SELECT count(*) FROM messages_fts_docsize`: one row per indexed message. */
  indexedDocs: number;
  /** `messages` rows with no docsize row. */
  unindexed: number;
  /** docsize rows with no `messages` row. */
  dangling: number;
  /** False when `messages_fts` does not exist (pre-FTS file); the counts are then 0. */
  ftsPresent: boolean;
}

/**
 * Row-set divergence between `messages` and its FTS index, read-only SQL (works
 * on a `readonly` handle and under `PRAGMA query_only`). It sees missing and
 * extra rows, not token-level mismatch: `deepCheckMessagesFts` finds those.
 * Pinned by __tests__/fts-health.test.ts ("probe ...").
 */
export function probeMessagesFts(db: Database.Database): FtsProbe {
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const messages = count('SELECT count(*) AS n FROM messages');
  const present = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
    .get();
  if (!present) return { messages, indexedDocs: 0, unindexed: 0, dangling: 0, ftsPresent: false };
  const indexedDocs = count('SELECT count(*) AS n FROM messages_fts_docsize');
  const matched = count(
    'SELECT count(*) AS n FROM messages m JOIN messages_fts_docsize d ON d.id = m.rowid',
  );
  return {
    messages,
    indexedDocs,
    unindexed: messages - matched,
    dangling: indexedDocs - matched,
    ftsPresent: true,
  };
}

/**
 * The authoritative FTS check: `integrity-check` with `rank = 1` also compares the
 * index against the content table, which `PRAGMA integrity_check` and the plain
 * `integrity-check` form both miss. It takes the write lock briefly, so it needs a
 * writable handle; a readonly or `query_only` handle fails with "attempt to write a
 * readonly database", reported as `ok: false`. Pinned by __tests__/fts-health.test.ts
 * ("deepCheck ...").
 */
export function deepCheckMessagesFts(db: Database.Database): { ok: boolean; detail?: string } {
  try {
    db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)");
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Rebuild the index from `messages`, which is the source of truth, so this is
 * lossless. Cost is linear in content size. Pinned by __tests__/fts-health.test.ts
 * ("rebuild ...").
 */
export function rebuildMessagesFts(db: Database.Database): void {
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
}

export type IntegrityClass = 'ok' | 'fts' | 'index' | 'heap' | 'unknown';

const SEVERITY: Record<'fts' | 'index' | 'heap', number> = { fts: 1, index: 2, heap: 3 };

/**
 * Sort a `PRAGMA integrity_check` verdict (all rows joined; each row may itself
 * hold several lines) into the repair class it needs: fts -> rebuild, index ->
 * REINDEX, heap -> restore from backup.
 *
 * Mixed verdicts take the WORST class (heap > index > fts): a damaged table also
 * yields "row N missing from index X" lines, and REINDEX on top of a bad heap
 * would index the damage. A verdict with no recognised line is `unknown`, and so
 * is a thrown "database disk image is malformed" (no line to classify).
 * Pinned by __tests__/fts-health.test.ts ("classifyIntegrity ...").
 */
export function classifyIntegrity(verdict: string, db: Database.Database): IntegrityClass {
  if (verdict.trim() === 'ok') return 'ok';
  let roots: Map<number, 'fts' | 'index' | 'heap'> | undefined;
  const rootClass = (rootpage: number): 'fts' | 'index' | 'heap' | undefined => {
    if (!roots) {
      roots = new Map();
      try {
        const rows = db
          .prepare(
            "SELECT type, name, tbl_name AS tbl, rootpage FROM sqlite_master WHERE type IN ('table','index') AND rootpage > 0",
          )
          .all() as { type: string; name: string; tbl: string; rootpage: number }[];
        for (const r of rows) {
          if (r.tbl.startsWith('messages_fts')) roots.set(r.rootpage, 'fts');
          else roots.set(r.rootpage, r.type === 'index' ? 'index' : 'heap');
        }
      } catch {
        // unreadable schema: every Tree line stays unclassified, so the verdict is `unknown`
      }
    }
    return roots.get(rootpage);
  };

  let worst: 'fts' | 'index' | 'heap' | undefined;
  const note = (c: 'fts' | 'index' | 'heap' | undefined) => {
    if (c && (!worst || SEVERITY[c] > SEVERITY[worst])) worst = c;
  };
  for (const line of verdict.split('\n')) {
    const l = line.trim();
    const tree = /^Tree (\d+) page /.exec(l);
    if (l.startsWith('fts5:') || l.includes('messages_fts')) note('fts');
    else if (tree) note(rootClass(Number(tree[1])));
    else if (/^row \d+ missing from index /.test(l) || /^wrong # of entries in index /.test(l)) {
      note('index');
    }
  }
  return worst ?? 'unknown';
}
