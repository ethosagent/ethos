import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RETENTION_DEFAULTS } from '@ethosagent/types';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
      personality_id  TEXT,
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
      personality_id  TEXT NOT NULL,
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
});
