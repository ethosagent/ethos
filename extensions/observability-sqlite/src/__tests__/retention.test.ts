import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { RETENTION_DEFAULTS } from '@ethosagent/types';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore } from '../blob-store';
import { mergeRetentionConfig, parseDuration, pruneObservability } from '../retention';

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

describe('parseDuration', () => {
  it('parses 90d correctly', () => {
    expect(parseDuration('90d')).toBe(90 * 86_400_000);
  });

  it('returns null for "forever"', () => {
    expect(parseDuration('forever')).toBeNull();
  });

  it('parses 2w correctly', () => {
    expect(parseDuration('2w')).toBe(14 * 86_400_000);
  });

  it('parses months', () => {
    expect(parseDuration('1m')).toBe(30 * 86_400_000);
  });

  it('parses years', () => {
    expect(parseDuration('1y')).toBe(365 * 86_400_000);
  });

  it('throws on invalid duration string', () => {
    expect(() => parseDuration('invalid')).toThrow('Invalid duration: "invalid"');
  });

  it('throws on unsupported unit', () => {
    expect(() => parseDuration('10h')).toThrow('Invalid duration');
  });
});

// ---------------------------------------------------------------------------
// mergeRetentionConfig
// ---------------------------------------------------------------------------

describe('mergeRetentionConfig', () => {
  it('returns global config unchanged when no override', () => {
    const merged = mergeRetentionConfig(RETENTION_DEFAULTS);
    expect(merged.messages).toBe('365d');
    expect(merged.traces).toBe('90d');
  });

  it('override replaces specified fields only', () => {
    const merged = mergeRetentionConfig(RETENTION_DEFAULTS, { messages: '730d', blobs: '30d' });
    expect(merged.messages).toBe('730d');
    expect(merged.blobs).toBe('30d');
    expect(merged.traces).toBe('90d');
  });

  it('deep-merges events sub-block', () => {
    const merged = mergeRetentionConfig(RETENTION_DEFAULTS, {
      events: { audit: '1825d' },
    });
    expect(merged.events?.audit).toBe('1825d');
    expect(merged.events?.error).toBe('90d');
    expect(merged.events?.install).toBe('forever');
  });
});

// ---------------------------------------------------------------------------
// pruneObservability
// ---------------------------------------------------------------------------

function makeTestDb(): Database.Database {
  const db = new Database(join(tmpdir(), `obs-retention-test-${Date.now()}.db`));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS traces (
      trace_id        TEXT PRIMARY KEY,
      session_id      TEXT,
      kind            TEXT NOT NULL,
      start_ts        INTEGER NOT NULL,
      end_ts          INTEGER,
      status          TEXT,
      subject_id      TEXT,
      snapshot_id     TEXT,
      attrs           TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS spans (
      span_id         TEXT PRIMARY KEY,
      trace_id        TEXT NOT NULL,
      parent_span_id  TEXT,
      kind            TEXT NOT NULL,
      name            TEXT NOT NULL,
      start_ts        INTEGER NOT NULL,
      end_ts          INTEGER,
      status          TEXT,
      attrs           TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS events (
      event_id        TEXT PRIMARY KEY,
      trace_id        TEXT,
      span_id         TEXT,
      ts              INTEGER NOT NULL,
      category        TEXT NOT NULL,
      severity        TEXT NOT NULL,
      code            TEXT,
      cause           TEXT,
      details         TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS snapshots (
      snapshot_id     TEXT PRIMARY KEY,
      taken_at        INTEGER NOT NULL,
      subject_id      TEXT NOT NULL,
      body            TEXT NOT NULL
    ) STRICT;
  `);
  return db;
}

let db: Database.Database;

beforeEach(() => {
  db = makeTestDb();
});

afterEach(() => {
  db.close();
});

const NOW = 1_000_000_000_000; // fixed reference point
const OLD = NOW - 100 * 86_400_000; // 100 days ago — past 90d cutoff
const RECENT = NOW - 10 * 86_400_000; // 10 days ago — within 90d

function insertTrace(id: string, startTs: number): void {
  db.prepare(`INSERT INTO traces (trace_id, kind, start_ts) VALUES (?, 'turn', ?)`).run(
    id,
    startTs,
  );
}

function insertSpan(id: string, traceId: string, startTs: number): void {
  db.prepare(
    `INSERT INTO spans (span_id, trace_id, kind, name, start_ts) VALUES (?, ?, 'internal', 'test', ?)`,
  ).run(id, traceId, startTs);
}

function insertEvent(id: string, category: string, ts: number): void {
  db.prepare(`INSERT INTO events (event_id, category, severity, ts) VALUES (?, ?, 'info', ?)`).run(
    id,
    category,
    ts,
  );
}

describe('pruneObservability', () => {
  it('dry-run returns correct counts without deleting', () => {
    insertTrace('old-trace', OLD);
    insertTrace('new-trace', RECENT);
    insertSpan('old-span', 'old-trace', OLD);
    insertSpan('new-span', 'new-trace', RECENT);
    insertEvent('old-error', 'error', OLD);
    insertEvent('new-error', 'error', RECENT);

    const result = pruneObservability(db, RETENTION_DEFAULTS, { dryRun: true, now: NOW });

    expect(result.traces).toBe(1);
    expect(result.spans).toBe(1);
    expect(result.events).toBe(1);

    // Nothing actually deleted
    const traceCount = (db.prepare('SELECT COUNT(*) as n FROM traces').get() as { n: number }).n;
    expect(traceCount).toBe(2);
  });

  it('actually deletes old rows and keeps recent ones', () => {
    insertTrace('old-trace', OLD);
    insertTrace('new-trace', RECENT);
    insertSpan('old-span', 'old-trace', OLD);
    insertSpan('new-span', 'new-trace', RECENT);
    insertEvent('old-error', 'error', OLD);
    insertEvent('new-error', 'error', RECENT);

    const result = pruneObservability(db, RETENTION_DEFAULTS, { dryRun: false, now: NOW });

    expect(result.traces).toBe(1);
    expect(result.spans).toBe(1);
    expect(result.events).toBe(1);

    const remainingTraces = (db.prepare('SELECT COUNT(*) as n FROM traces').get() as { n: number })
      .n;
    const remainingSpans = (db.prepare('SELECT COUNT(*) as n FROM spans').get() as { n: number }).n;
    const remainingEvents = (db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number })
      .n;

    expect(remainingTraces).toBe(1);
    expect(remainingSpans).toBe(1);
    expect(remainingEvents).toBe(1);
  });

  it('respects "forever" — install events are never deleted', () => {
    insertEvent('old-install', 'install.setup', OLD);
    insertEvent('new-install', 'install.setup', RECENT);

    const result = pruneObservability(db, RETENTION_DEFAULTS, { dryRun: false, now: NOW });

    expect(result.events).toBe(0); // install.% is forever

    const remaining = (db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number }).n;
    expect(remaining).toBe(2);
  });

  it('prunes audit events past their TTL', () => {
    // Old enough to be past 365d audit TTL
    const veryOld = NOW - 400 * 86_400_000;
    insertEvent('old-audit', 'audit.tool_call', veryOld);
    insertEvent('new-audit', 'audit.tool_call', RECENT);

    const result = pruneObservability(db, RETENTION_DEFAULTS, { dryRun: false, now: NOW });

    expect(result.events).toBe(1);
    const remaining = (db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number }).n;
    expect(remaining).toBe(1);
  });

  it('orphaned snapshots are pruned; snapshots referenced by surviving traces are kept', () => {
    // snap-A is referenced by an old trace that will be pruned
    // snap-B is referenced by a recent trace that survives
    // snap-C is orphaned (no trace references it)
    db.prepare(
      `INSERT INTO traces (trace_id, kind, start_ts, snapshot_id) VALUES (?, 'turn', ?, ?)`,
    ).run('old-trace', OLD, 'snap-A');
    db.prepare(
      `INSERT INTO traces (trace_id, kind, start_ts, snapshot_id) VALUES (?, 'turn', ?, ?)`,
    ).run('new-trace', RECENT, 'snap-B');
    for (const [id] of [['snap-A'], ['snap-B'], ['snap-C']]) {
      db.prepare(
        `INSERT INTO snapshots (snapshot_id, taken_at, subject_id, body) VALUES (?, ?, 'eng', '{}')`,
      ).run(id, RECENT);
    }

    const result = pruneObservability(db, RETENTION_DEFAULTS, { dryRun: false, now: NOW });

    expect(result.traces).toBe(1); // old-trace pruned
    expect(result.snapshots).toBe(2); // snap-A (now orphaned) + snap-C (always orphaned)

    const snaps = (
      db.prepare('SELECT snapshot_id FROM snapshots').all() as { snapshot_id: string }[]
    ).map((r) => r.snapshot_id);
    expect(snaps).toEqual(['snap-B']); // only the referenced survivor remains
  });

  it('per-subject retention override: longer TTL prevents pruning', () => {
    // OLD trace is 100 days old — past the 90d default but within a 200d override
    insertTrace('old-trace', OLD);

    const override = mergeRetentionConfig(RETENTION_DEFAULTS, { traces: '200d', spans: '200d' });
    const result = pruneObservability(db, override, { dryRun: false, now: NOW });

    expect(result.traces).toBe(0); // NOT pruned under 200d TTL
    const remaining = (db.prepare('SELECT COUNT(*) as n FROM traces').get() as { n: number }).n;
    expect(remaining).toBe(1);
  });

  it('per-subject retention override: shorter TTL prunes more aggressively', () => {
    // RECENT trace is 10 days old — within 90d default but past a 7d override
    insertTrace('recent-trace', RECENT);

    const override = mergeRetentionConfig(RETENTION_DEFAULTS, { traces: '7d', spans: '7d' });
    const result = pruneObservability(db, override, { dryRun: false, now: NOW });

    expect(result.traces).toBe(1); // pruned under 7d TTL
    const remaining = (db.prepare('SELECT COUNT(*) as n FROM traces').get() as { n: number }).n;
    expect(remaining).toBe(0);
  });

  it('excludeSubjectIds: global pass does not delete rows belonging to excluded subjects', () => {
    // subject-A trace is 100 days old (past 90d global) but should survive because
    // subject A is excluded from the global pass (it has its own longer-TTL pass).
    db.prepare(
      `INSERT INTO traces (trace_id, kind, start_ts, subject_id) VALUES (?, 'turn', ?, ?)`,
    ).run('a-trace', OLD, 'subject-a');
    // Unscoped trace of the same age — no subject, should be pruned by global pass.
    insertTrace('global-trace', OLD);

    const result = pruneObservability(db, RETENTION_DEFAULTS, {
      dryRun: false,
      now: NOW,
      excludeSubjectIds: ['subject-a'],
    });

    expect(result.traces).toBe(1); // only global-trace pruned
    const remaining = (
      db.prepare('SELECT trace_id FROM traces').all() as { trace_id: string }[]
    ).map((r) => r.trace_id);
    expect(remaining).toEqual(['a-trace']); // subject-a row survives
  });

  it('messages pruning uses ISO timestamp column and prunes old messages', () => {
    // Create a minimal sessions.db schema in a separate in-memory db.
    const sessDb = new Database(':memory:');
    sessDb.exec(`
      CREATE TABLE messages (
        id       INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        content    TEXT NOT NULL,
        timestamp  TEXT NOT NULL
      ) STRICT;
    `);

    // Messages retention default is 365d. Use 400d-old message to cross the cutoff.
    const veryOld = NOW - 400 * 86_400_000;
    const oldIso = new Date(veryOld).toISOString();
    const recentIso = new Date(RECENT).toISOString();
    sessDb
      .prepare('INSERT INTO messages (session_id, content, timestamp) VALUES (?, ?, ?)')
      .run('s1', 'old msg', oldIso);
    sessDb
      .prepare('INSERT INTO messages (session_id, content, timestamp) VALUES (?, ?, ?)')
      .run('s1', 'recent msg', recentIso);

    const result = pruneObservability(db, RETENTION_DEFAULTS, {
      dryRun: false,
      now: NOW,
      sessDb,
    });

    expect(result.messages).toBe(1); // old message pruned
    const remaining = (sessDb.prepare('SELECT COUNT(*) as n FROM messages').get() as { n: number })
      .n;
    expect(remaining).toBe(1); // recent message kept
    sessDb.close();
  });
});

// ---------------------------------------------------------------------------
// G4: referenced blobs survive prune
// ---------------------------------------------------------------------------

describe('pruneObservability — referenced blobs survive', () => {
  it('prune deletes expired DB rows but does not touch blob files', async () => {
    // Set up an in-memory blob store with a single blob.
    const storage = new InMemoryStorage();
    const blobStore = new BlobStore('/blobs', storage);
    const blobKey = await blobStore.put('tool result body content');

    // Insert a span (RECENT — within 90d TTL) that references the blob.
    const dbPath = join(tmpdir(), `obs-blob-survival-${Date.now()}.db`);
    const obsDb = new Database(dbPath);
    obsDb.pragma('journal_mode = WAL');
    obsDb.exec(`
      CREATE TABLE IF NOT EXISTS traces (trace_id TEXT PRIMARY KEY, kind TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER, status TEXT, subject_id TEXT, snapshot_id TEXT, attrs TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS spans (span_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_span_id TEXT, kind TEXT NOT NULL, name TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER, status TEXT, attrs TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, trace_id TEXT, span_id TEXT, ts INTEGER NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, code TEXT, cause TEXT, details TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS snapshots (snapshot_id TEXT PRIMARY KEY, taken_at INTEGER NOT NULL, subject_id TEXT NOT NULL, body TEXT NOT NULL) STRICT;
    `);

    // Old trace + span (past 90d TTL) — will be pruned.
    obsDb
      .prepare(`INSERT INTO traces (trace_id, kind, start_ts) VALUES ('old-t', 'turn', ?)`)
      .run(OLD);
    obsDb
      .prepare(
        `INSERT INTO spans (span_id, trace_id, kind, name, start_ts, attrs) VALUES ('old-s', 'old-t', 'tool_call', 'bash', ?, ?)`,
      )
      .run(OLD, JSON.stringify({ body_ref: blobKey }));

    // Recent trace + span (within 90d TTL) — survives prune.
    obsDb
      .prepare(`INSERT INTO traces (trace_id, kind, start_ts) VALUES ('new-t', 'turn', ?)`)
      .run(RECENT);
    obsDb
      .prepare(
        `INSERT INTO spans (span_id, trace_id, kind, name, start_ts, attrs) VALUES ('new-s', 'new-t', 'tool_call', 'bash', ?, ?)`,
      )
      .run(RECENT, JSON.stringify({ body_ref: blobKey }));

    const result = pruneObservability(obsDb, RETENTION_DEFAULTS, { dryRun: false, now: NOW });
    obsDb.close();

    // DB rows correctly pruned.
    expect(result.spans).toBe(1); // old-s pruned
    expect(result.traces).toBe(1); // old-t pruned

    // Blob file still exists — prune only touches DB rows, never blob files.
    const blobPath = `/blobs/${blobKey.slice(0, 2)}/${blobKey}.gz`;
    expect(await storage.exists(blobPath)).toBe(true);
  });
});
