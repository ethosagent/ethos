// otlp-export §4.1 — per-sink export state. `trace_exports(sink, trace_id)`
// gives each export sink its own claim cursor (D9): Langfuse keeps
// `traces.exported_at`/`claimed_at`, and a second sink claiming the same
// traces must never steal Langfuse's rows or vice versa.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import type { Trace } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteObservabilityStore } from '../store';

let tmp: string;
let dbPath: string;
let store: SQLiteObservabilityStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obs-trace-exports-'));
  dbPath = join(tmp, 'observability.db');
  store = new SQLiteObservabilityStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

function closedTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    traceId: randomUUID(),
    sessionId: 'sess-1',
    kind: 'turn',
    startTs: Date.now(),
    endTs: Date.now() + 500,
    status: 'ok',
    subjectId: 'assistant',
    attrs: { platform: 'telegram' },
    ...overrides,
  };
}

function insertClosed(overrides: Partial<Trace> = {}): Trace {
  const trace = closedTrace(overrides);
  store.insertTrace(trace);
  return trace;
}

function traceIds(claimed: Array<{ trace: Trace }>): string[] {
  return claimed.map((c) => c.trace.traceId).sort();
}

// The v3 schema as it shipped: claim columns on `traces`, no `trace_exports`.
const V3_SCHEMA = `
  CREATE TABLE traces (
    trace_id        TEXT PRIMARY KEY,
    session_id      TEXT,
    kind            TEXT NOT NULL,
    start_ts        INTEGER NOT NULL,
    end_ts          INTEGER,
    status          TEXT,
    subject_id      TEXT,
    snapshot_id     TEXT,
    attrs           TEXT,
    exported_at     INTEGER,
    claimed_at      INTEGER
  ) STRICT;
  CREATE INDEX idx_traces_session ON traces(session_id, start_ts);
  CREATE INDEX idx_traces_kind    ON traces(kind, start_ts);
  CREATE TABLE spans (
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
  CREATE TABLE events (
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
  CREATE TABLE snapshots (
    snapshot_id     TEXT PRIMARY KEY,
    taken_at        INTEGER NOT NULL,
    subject_id      TEXT NOT NULL,
    body            TEXT NOT NULL
  ) STRICT;
  CREATE TABLE metric_counters (
    metric      TEXT NOT NULL,
    labels      TEXT NOT NULL,
    value       REAL NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (metric, labels)
  ) STRICT;
  PRAGMA user_version = 3;
`;

describe('schema v4 migration', () => {
  it('migrates a v3 DB to v4 without touching the Langfuse claim columns', () => {
    const v3Path = join(tmp, 'v3.db');
    const seed = new Database(v3Path);
    seed.exec(V3_SCHEMA);
    const insert = seed.prepare(
      `INSERT INTO traces (trace_id, kind, start_ts, status, exported_at, claimed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run('t-exported', 'turn', 100, 'ok', 555, null);
    insert.run('t-claimed', 'turn', 200, 'ok', null, 777);
    seed.close();

    const migrated = new SQLiteObservabilityStore(v3Path);
    migrated.close();

    const verify = new Database(v3Path);
    try {
      const version = (verify.pragma('user_version') as Array<{ user_version: number }>)[0];
      expect(version?.user_version).toBe(4);

      const table = verify
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trace_exports'`)
        .get();
      expect(table).toBeDefined();
      expect(verify.prepare('SELECT COUNT(*) AS n FROM trace_exports').get()).toEqual({ n: 0 });

      // Langfuse's per-trace claim state is untouched by the migration.
      const rows = verify
        .prepare('SELECT trace_id, exported_at, claimed_at FROM traces ORDER BY start_ts')
        .all();
      expect(rows).toEqual([
        { trace_id: 't-exported', exported_at: 555, claimed_at: null },
        { trace_id: 't-claimed', exported_at: null, claimed_at: 777 },
      ]);
    } finally {
      verify.close();
    }
  });
});

describe('claimTracesForSink', () => {
  it('skips open traces, traces older than minStartTs, and traces with a terminal row', () => {
    insertClosed({ status: undefined, endTs: undefined }); // open — no status
    insertClosed({ startTs: 1000 }); // closed but older than minStartTs

    // Make one trace terminal for 'otlp' before the eligible one exists.
    const terminal = insertClosed();
    const claimedFirst = store.claimTracesForSink('otlp', 10, 120_000, 2000);
    expect(traceIds(claimedFirst)).toEqual([terminal.traceId]);
    const firstClaim = claimedFirst[0];
    if (!firstClaim) throw new Error('expected a claim');
    store.markSinkExported('otlp', terminal.traceId, firstClaim.claimedAt, 'exported');

    const eligible = insertClosed();
    const claimed = store.claimTracesForSink('otlp', 10, 120_000, 2000);
    expect(traceIds(claimed)).toEqual([eligible.traceId]);
  });

  it('two store handles on one file claim disjoint sets', () => {
    for (let i = 0; i < 5; i++) insertClosed();

    const store2 = new SQLiteObservabilityStore(dbPath);
    try {
      const claimed1 = store.claimTracesForSink('otlp', 3, 120_000, 0);
      const claimed2 = store2.claimTracesForSink('otlp', 3, 120_000, 0);

      expect(claimed1).toHaveLength(3);
      expect(claimed2).toHaveLength(2);
      const ids1 = new Set(traceIds(claimed1));
      for (const id of traceIds(claimed2)) expect(ids1.has(id)).toBe(false);
    } finally {
      store2.close();
    }
  });

  it('reclaims a stale claim, and a superseded markSinkExported is a no-op', async () => {
    const trace = insertClosed();

    const claimed = store.claimTracesForSink('otlp', 10, 120_000, 0);
    expect(claimed).toHaveLength(1);
    const original = claimed[0];
    if (!original) throw new Error('expected a claim');

    // A fresh claim is not re-claimable.
    expect(store.claimTracesForSink('otlp', 10, 120_000, 0)).toHaveLength(0);

    // Let wall-clock time move past the claim timestamp, then use a cutoff
    // of 0 so it reads as stale — a fresh poller reclaims it.
    await new Promise((r) => setTimeout(r, 5));
    const reclaimed = store.claimTracesForSink('otlp', 10, 0, 0);
    expect(traceIds(reclaimed)).toEqual([trace.traceId]);

    // The original, now-late caller must not stamp the reclaimed row.
    store.markSinkExported('otlp', trace.traceId, original.claimedAt, 'exported');
    const verify = new Database(dbPath);
    try {
      const row = verify
        .prepare(`SELECT exported_at, outcome FROM trace_exports WHERE sink = 'otlp'`)
        .get() as { exported_at: number | null; outcome: string | null };
      expect(row.exported_at).toBeNull();
      expect(row.outcome).toBeNull();
    } finally {
      verify.close();
    }

    // The live claim-holder can, and a release with a superseded claimedAt
    // is equally a no-op.
    store.releaseSinkClaim('otlp', trace.traceId, original.claimedAt);
    const reclaim = reclaimed[0];
    if (!reclaim) throw new Error('expected a claim');
    store.markSinkExported('otlp', trace.traceId, reclaim.claimedAt, 'exported');
    expect(store.claimTracesForSink('otlp', 10, 0, 0)).toHaveLength(0);
  });

  it('never touches traces.exported_at, and both sinks see the same trace', () => {
    const trace = insertClosed();

    // Claim + terminally stamp for 'otlp'…
    const otlpClaims = store.claimTracesForSink('otlp', 10, 120_000, 0);
    const otlpClaim = otlpClaims[0];
    if (!otlpClaim) throw new Error('expected a claim');
    store.markSinkExported('otlp', trace.traceId, otlpClaim.claimedAt, 'exported');

    // …the Langfuse columns are untouched and Langfuse still sees the trace.
    const langfuse = store.claimUnexportedTraces(10, 120_000);
    expect(traceIds(langfuse)).toEqual([trace.traceId]);
    const lfClaim = langfuse[0];
    if (!lfClaim) throw new Error('expected a claim');
    store.markTraceExported(trace.traceId, lfClaim.claimedAt);

    // And a second sink is not blocked by 'otlp' being terminal.
    const other = store.claimTracesForSink('other-sink', 10, 120_000, 0);
    expect(traceIds(other)).toEqual([trace.traceId]);
  });
});

describe('markStaleForSink', () => {
  it('stamps closed, unclaimed, unexported traces terminal and returns the count', () => {
    const oldA = insertClosed({ startTs: 1000 });
    const oldB = insertClosed({ startTs: 1500 });
    insertClosed({ startTs: 1200, status: undefined, endTs: undefined }); // open — skipped
    const recent = insertClosed({ startTs: 5000 });

    expect(store.markStaleForSink('otlp', 2000)).toBe(2);

    const verify = new Database(dbPath);
    try {
      const rows = verify
        .prepare(
          `SELECT trace_id, outcome FROM trace_exports
            WHERE sink = 'otlp' AND exported_at IS NOT NULL ORDER BY trace_id`,
        )
        .all() as Array<{ trace_id: string; outcome: string }>;
      expect(rows).toEqual(
        [oldA.traceId, oldB.traceId]
          .sort()
          .map((trace_id) => ({ trace_id, outcome: 'dropped_backlog' })),
      );
    } finally {
      verify.close();
    }

    // Idempotent, and the recent trace stays claimable.
    expect(store.markStaleForSink('otlp', 2000)).toBe(0);
    expect(traceIds(store.claimTracesForSink('otlp', 10, 120_000, 0))).toEqual([recent.traceId]);
  });

  it('leaves a live claim alone', () => {
    insertClosed({ startTs: 1000 });
    const claimed = store.claimTracesForSink('otlp', 10, 120_000, 0);
    expect(claimed).toHaveLength(1);

    expect(store.markStaleForSink('otlp', Date.now() + 60_000)).toBe(0);
  });
});

describe('oldestUnexportedStartTs', () => {
  it('returns the oldest pending start_ts and null once everything is terminal', () => {
    expect(store.oldestUnexportedStartTs('otlp')).toBeNull();

    insertClosed({ startTs: 3000 });
    const oldest = insertClosed({ startTs: 1000 });
    insertClosed({ startTs: 500, status: undefined, endTs: undefined }); // open — not pending

    expect(store.oldestUnexportedStartTs('otlp')).toBe(1000);

    // A live claim is still pending.
    const claimed = store.claimTracesForSink('otlp', 10, 120_000, 0);
    expect(claimed).toHaveLength(2);
    expect(store.oldestUnexportedStartTs('otlp')).toBe(1000);

    for (const c of claimed) {
      store.markSinkExported('otlp', c.trace.traceId, c.claimedAt, 'exported');
    }
    expect(store.oldestUnexportedStartTs('otlp')).toBeNull();

    // Per-sink: another sink still sees both traces pending.
    expect(store.oldestUnexportedStartTs('langfuse-otlp')).toBe(oldest.startTs);
  });
});
