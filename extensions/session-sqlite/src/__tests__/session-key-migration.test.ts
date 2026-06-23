import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteSessionStore } from '../index';
import { decideMigration, migrateSessionKeys } from '../session-key-migration';

// Multi-bot routing session-key migration. Pure decision logic is
// unit-tested here; the SQLite-touching `migrateSessionKeys` wrapper
// is covered by the gateway boot integration path in Phase 5.

describe('decideMigration', () => {
  const known = new Map<string, Set<string>>([
    ['telegram', new Set(['t1key', 't2key'])],
    ['slack', new Set(['s1key'])],
  ]);
  const primary = new Map<string, string>([
    ['telegram', 't1key'],
    ['slack', 's1key'],
  ]);

  it('rewrites a legacy 2-part key by prepending the primary botKey', () => {
    expect(decideMigration('telegram:42', known, primary)).toEqual({
      kind: 'rewrite',
      newKey: 'telegram:t1key:42',
    });
  });

  it('preserves the /new timestamp suffix on legacy keys', () => {
    expect(decideMigration('telegram:42:1234567890', known, primary)).toEqual({
      kind: 'rewrite',
      newKey: 'telegram:t1key:42:1234567890',
    });
  });

  it('recognizes already-migrated keys via the known-botKey set', () => {
    expect(decideMigration('telegram:t1key:42', known, primary)).toEqual({
      kind: 'skip-already-migrated',
    });
    expect(decideMigration('telegram:t2key:42:9999', known, primary)).toEqual({
      kind: 'skip-already-migrated',
    });
  });

  it('skips rows whose platform has no configured bot', () => {
    expect(decideMigration('discord:42', known, primary)).toEqual({ kind: 'skip-no-bot' });
  });

  it('skips malformed keys with no platform segment', () => {
    expect(decideMigration('orphan', known, primary)).toEqual({ kind: 'skip-no-bot' });
  });

  it('routes slack legacy sessions to the slack primary botKey', () => {
    expect(decideMigration('slack:C001:1234', known, primary)).toEqual({
      kind: 'rewrite',
      newKey: 'slack:s1key:C001:1234',
    });
  });

  it('migration of a row twice is a no-op (idempotency on the second pass)', () => {
    // First pass produces the new key…
    const first = decideMigration('telegram:42', known, primary);
    expect(first.kind).toBe('rewrite');
    if (first.kind !== 'rewrite') return;
    // …feeding that back in is a no-op.
    expect(decideMigration(first.newKey, known, primary)).toEqual({
      kind: 'skip-already-migrated',
    });
  });
});

// ---------------------------------------------------------------------------
// migrateSessionKeys — SQLite-backed integration tests.
//
// The decision function is pure and unit-tested above; this block covers
// the actual DB rewrite, including the case that motivated the fix:
// a partially-migrated database where the same logical chat appears as
// both `telegram:42` (legacy) and `telegram:<botKey>:42` (post-migration).
// ---------------------------------------------------------------------------

describe('migrateSessionKeys (SQLite integration)', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-keys-mig-'));
    dbPath = join(tempDir, 'sessions.db');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seed(rows: Array<{ key: string; platform: string }>): void {
    // Use SQLiteSessionStore to set up the schema, then write rows
    // directly via SQL — bypassing createSession's `usage` requirement
    // since the migration only inspects `key`.
    const store = new SQLiteSessionStore(dbPath);
    store.close();
    const db = new Database(dbPath);
    try {
      const insert = db.prepare(
        `INSERT INTO sessions (id, key, platform, model, provider, created_at, updated_at)
         VALUES (?, ?, ?, 'm', 'p', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      );
      for (const [i, r] of rows.entries()) {
        insert.run(`id-${i}`, r.key, r.platform);
      }
    } finally {
      db.close();
    }
  }

  function readAllKeys(): string[] {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare('SELECT key FROM sessions ORDER BY key').all() as Array<{
        key: string;
      }>;
      return rows.map((r) => r.key);
    } finally {
      db.close();
    }
  }

  const known = new Map<string, Set<string>>([['telegram', new Set(['t1key'])]]);
  const primary = new Map<string, string>([['telegram', 't1key']]);

  it('rewrites a clean legacy DB to the new key shape', async () => {
    seed([
      { key: 'telegram:42', platform: 'telegram' },
      { key: 'telegram:99:1700000000000', platform: 'telegram' },
    ]);
    const result = migrateSessionKeys({
      dbPath,
      knownByPlatform: known,
      primaryByPlatform: primary,
    });
    expect(result).toEqual({
      migrated: 2,
      alreadyMigrated: 0,
      skippedNoBot: 0,
      quarantinedStale: 0,
    });
    expect(readAllKeys()).toEqual(['telegram:t1key:42', 'telegram:t1key:99:1700000000000']);
  });

  it('is idempotent on a fully-migrated DB (re-run is a no-op)', async () => {
    seed([{ key: 'telegram:t1key:42', platform: 'telegram' }]);
    const result = migrateSessionKeys({
      dbPath,
      knownByPlatform: known,
      primaryByPlatform: primary,
    });
    expect(result).toEqual({
      migrated: 0,
      alreadyMigrated: 1,
      skippedNoBot: 0,
      quarantinedStale: 0,
    });
    expect(readAllKeys()).toEqual(['telegram:t1key:42']);
  });

  it('quarantines stale legacy rows when the canonical target is taken', async () => {
    // Mixed legacy + migrated rows for the same chat — the legacy row
    // is dead history, the new one is the live session. The fix is
    // not to skip the legacy row (Codex flagged that as a maintenance
    // trap: both keys live in the main namespace forever); instead the
    // legacy row gets quarantined under `__legacy:` so any future
    // session-listing / search / retention code can filter it cleanly
    // by prefix.
    seed([
      { key: 'telegram:42', platform: 'telegram' },
      { key: 'telegram:t1key:42', platform: 'telegram' },
    ]);

    const result = migrateSessionKeys({
      dbPath,
      knownByPlatform: known,
      primaryByPlatform: primary,
    });
    expect(result).toEqual({
      migrated: 0,
      alreadyMigrated: 1, // telegram:t1key:42
      skippedNoBot: 0,
      quarantinedStale: 1, // telegram:42 → __legacy:telegram:42
    });
    // Stale row was renamed; live row untouched. The main namespace
    // contains only the canonical key plus the quarantined ghost.
    expect(readAllKeys()).toEqual(['__legacy:telegram:42', 'telegram:t1key:42']);
  });

  it('quarantine is idempotent — already-quarantined rows are left alone on re-run', async () => {
    seed([
      { key: '__legacy:telegram:42', platform: 'telegram' },
      { key: 'telegram:t1key:42', platform: 'telegram' },
    ]);

    const result = migrateSessionKeys({
      dbPath,
      knownByPlatform: known,
      primaryByPlatform: primary,
    });
    // `__legacy:*` rows are skipped entirely (they're dead history);
    // the live row is recognized as already-migrated.
    expect(result).toEqual({
      migrated: 0,
      alreadyMigrated: 1,
      skippedNoBot: 0,
      quarantinedStale: 0,
    });
    expect(readAllKeys()).toEqual(['__legacy:telegram:42', 'telegram:t1key:42']);
  });

  it('skips rows whose platform has no configured bot', async () => {
    seed([{ key: 'discord:42', platform: 'discord' }]);
    const result = migrateSessionKeys({
      dbPath,
      knownByPlatform: known,
      primaryByPlatform: primary,
    });
    expect(result.migrated).toBe(0);
    expect(result.skippedNoBot).toBe(1);
    expect(readAllKeys()).toEqual(['discord:42']);
  });
});
