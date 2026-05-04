import type { ObsEvent, ObservabilityStore, PolicySnapshot, Span, Trace } from '@ethosagent/types';
import Database from 'better-sqlite3';
import { redactJson, redactString } from './redact';

// ---------------------------------------------------------------------------
// SQLiteObservabilityStore
// Implements ObservabilityStore using better-sqlite3 (synchronous).
// STRICT tables throughout. All methods are synchronous inside.
// ---------------------------------------------------------------------------

export class SQLiteObservabilityStore implements ObservabilityStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------

  private migrate(): void {
    this.db.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id, start_ts);
      CREATE INDEX IF NOT EXISTS idx_traces_kind    ON traces(kind, start_ts);

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
      CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id, start_ts);
      CREATE INDEX IF NOT EXISTS idx_spans_name  ON spans(name, start_ts);

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
      CREATE INDEX IF NOT EXISTS idx_events_trace    ON events(trace_id, ts);
      CREATE INDEX IF NOT EXISTS idx_events_category ON events(category, ts);
      CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity, ts);

      CREATE TABLE IF NOT EXISTS snapshots (
        snapshot_id     TEXT PRIMARY KEY,
        taken_at        INTEGER NOT NULL,
        personality_id  TEXT NOT NULL,
        body            TEXT NOT NULL
      ) STRICT;
    `);
  }

  // ---------------------------------------------------------------------------
  // Traces
  // ---------------------------------------------------------------------------

  insertTrace(trace: Trace): void {
    const attrsJson = trace.attrs ? JSON.stringify(redactJson(trace.attrs)) : null;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO traces
         (trace_id, session_id, kind, start_ts, end_ts, status, personality_id, snapshot_id, attrs)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        trace.traceId,
        trace.sessionId ?? null,
        trace.kind,
        trace.startTs,
        trace.endTs ?? null,
        trace.status ?? null,
        trace.personalityId ?? null,
        trace.snapshotId ?? null,
        attrsJson,
      );
  }

  closeTrace(traceId: string, status: 'ok' | 'error' | 'aborted'): void {
    this.db
      .prepare(`UPDATE traces SET end_ts = ?, status = ? WHERE trace_id = ?`)
      .run(Date.now(), status, traceId);
  }

  getTrace(traceId: string): Trace | null {
    const row = this.db.prepare('SELECT * FROM traces WHERE trace_id = ?').get(traceId);
    return row ? rowToTrace(row as TraceRow) : null;
  }

  getRecentTraces(limit: number): Trace[] {
    const rows = this.db.prepare('SELECT * FROM traces ORDER BY start_ts DESC LIMIT ?').all(limit);
    return (rows as TraceRow[]).map(rowToTrace);
  }

  // ---------------------------------------------------------------------------
  // Spans
  // ---------------------------------------------------------------------------

  insertSpan(span: Span): void {
    const attrsJson = span.attrs ? JSON.stringify(redactJson(span.attrs)) : null;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO spans
         (span_id, trace_id, parent_span_id, kind, name, start_ts, end_ts, status, attrs)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        span.spanId,
        span.traceId,
        span.parentSpanId ?? null,
        span.kind,
        span.name,
        span.startTs,
        span.endTs ?? null,
        span.status ?? null,
        attrsJson,
      );
  }

  closeSpan(spanId: string, status: 'ok' | 'error' | 'blocked'): void {
    this.db
      .prepare(`UPDATE spans SET end_ts = ?, status = ? WHERE span_id = ?`)
      .run(Date.now(), status, spanId);
  }

  getSpans(traceId: string): Span[] {
    const rows = this.db
      .prepare('SELECT * FROM spans WHERE trace_id = ? ORDER BY start_ts ASC')
      .all(traceId);
    return (rows as SpanRow[]).map(rowToSpan);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  insertEvent(event: ObsEvent): void {
    const detailsJson = event.details ? JSON.stringify(redactJson(event.details)) : null;
    const cause = event.cause ? redactString(event.cause) : null;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events
         (event_id, trace_id, span_id, ts, category, severity, code, cause, details)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        event.eventId,
        event.traceId ?? null,
        event.spanId ?? null,
        event.ts,
        event.category,
        event.severity,
        event.code ?? null,
        cause,
        detailsJson,
      );
  }

  getEvents(filter: {
    traceId?: string;
    category?: string;
    since?: number;
    limit?: number;
  }): ObsEvent[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter.traceId !== undefined) {
      conditions.push('trace_id = ?');
      values.push(filter.traceId);
    }
    if (filter.category !== undefined) {
      conditions.push('category = ?');
      values.push(filter.category);
    }
    if (filter.since !== undefined) {
      conditions.push('ts >= ?');
      values.push(filter.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const lim = filter.limit ?? 100;
    const rows = this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY ts DESC LIMIT ?`)
      .all(...values, lim);
    return (rows as EventRow[]).map(rowToEvent);
  }

  // ---------------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------------

  insertSnapshot(snapshot: PolicySnapshot): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO snapshots (snapshot_id, taken_at, personality_id, body)
         VALUES (?,?,?,?)`,
      )
      .run(snapshot.snapshotId, snapshot.takenAt, snapshot.personalityId, snapshot.body);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Row types & mappers
// ---------------------------------------------------------------------------

interface TraceRow {
  trace_id: string;
  session_id: string | null;
  kind: string;
  start_ts: number;
  end_ts: number | null;
  status: string | null;
  personality_id: string | null;
  snapshot_id: string | null;
  attrs: string | null;
}

interface SpanRow {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  kind: string;
  name: string;
  start_ts: number;
  end_ts: number | null;
  status: string | null;
  attrs: string | null;
}

interface EventRow {
  event_id: string;
  trace_id: string | null;
  span_id: string | null;
  ts: number;
  category: string;
  severity: string;
  code: string | null;
  cause: string | null;
  details: string | null;
}

function rowToTrace(r: TraceRow): Trace {
  return {
    traceId: r.trace_id,
    sessionId: r.session_id ?? undefined,
    kind: r.kind as Trace['kind'],
    startTs: r.start_ts,
    endTs: r.end_ts ?? undefined,
    status: (r.status as Trace['status']) ?? undefined,
    personalityId: r.personality_id ?? undefined,
    snapshotId: r.snapshot_id ?? undefined,
    attrs: r.attrs ? (JSON.parse(r.attrs) as Record<string, unknown>) : undefined,
  };
}

function rowToSpan(r: SpanRow): Span {
  return {
    spanId: r.span_id,
    traceId: r.trace_id,
    parentSpanId: r.parent_span_id ?? undefined,
    kind: r.kind as Span['kind'],
    name: r.name,
    startTs: r.start_ts,
    endTs: r.end_ts ?? undefined,
    status: (r.status as Span['status']) ?? undefined,
    attrs: r.attrs ? (JSON.parse(r.attrs) as Record<string, unknown>) : undefined,
  };
}

function rowToEvent(r: EventRow): ObsEvent {
  return {
    eventId: r.event_id,
    traceId: r.trace_id ?? undefined,
    spanId: r.span_id ?? undefined,
    ts: r.ts,
    category: r.category as ObsEvent['category'],
    severity: r.severity as ObsEvent['severity'],
    code: r.code ?? undefined,
    cause: r.cause ?? undefined,
    details: r.details ? (JSON.parse(r.details) as Record<string, unknown>) : undefined,
  };
}
