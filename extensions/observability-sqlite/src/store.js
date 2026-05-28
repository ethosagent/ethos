import Database from 'better-sqlite3';
import { redactJson, redactString } from './redact';
// ---------------------------------------------------------------------------
// SQLiteObservabilityStore
// Implements ObservabilityStore using better-sqlite3 (synchronous).
// STRICT tables throughout. All methods are synchronous inside.
// ---------------------------------------------------------------------------
export class SQLiteObservabilityStore {
  db;
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }
  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------
  migrate() {
    // Rename pre-existing legacy columns BEFORE any new-schema operation so
    // that indexes / future schema additions referencing `subject_id` always
    // see the renamed column.
    this.renameLegacySubjectColumns();
    this.db.exec(`
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
        subject_id      TEXT NOT NULL,
        body            TEXT NOT NULL
      ) STRICT;
    `);
  }
  // Idempotent rename for databases created before the personality_id →
  // subject_id rename. Skipped when the new schema is already in place.
  renameLegacySubjectColumns() {
    for (const table of ['traces', 'snapshots']) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
      const names = new Set(columns.map((c) => c.name));
      if (names.has('personality_id') && !names.has('subject_id')) {
        this.db.exec(`ALTER TABLE ${table} RENAME COLUMN personality_id TO subject_id`);
      }
    }
  }
  // ---------------------------------------------------------------------------
  // Traces
  // ---------------------------------------------------------------------------
  insertTrace(trace) {
    const attrsJson = trace.attrs ? JSON.stringify(redactJson(trace.attrs)) : null;
    this.db
      .prepare(`INSERT OR IGNORE INTO traces
         (trace_id, session_id, kind, start_ts, end_ts, status, subject_id, snapshot_id, attrs)
         VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(
        trace.traceId,
        trace.sessionId ?? null,
        trace.kind,
        trace.startTs,
        trace.endTs ?? null,
        trace.status ?? null,
        trace.subjectId ?? null,
        trace.snapshotId ?? null,
        attrsJson,
      );
  }
  closeTrace(traceId, status) {
    this.db
      .prepare(`UPDATE traces SET end_ts = ?, status = ? WHERE trace_id = ?`)
      .run(Date.now(), status, traceId);
  }
  getTrace(traceId) {
    const row = this.db.prepare('SELECT * FROM traces WHERE trace_id = ?').get(traceId);
    return row ? rowToTrace(row) : null;
  }
  getRecentTraces(limit) {
    const rows = this.db.prepare('SELECT * FROM traces ORDER BY start_ts DESC LIMIT ?').all(limit);
    return rows.map(rowToTrace);
  }
  // ---------------------------------------------------------------------------
  // Spans
  // ---------------------------------------------------------------------------
  insertSpan(span, extraRedactPatterns) {
    const attrsJson = span.attrs
      ? JSON.stringify(redactJson(span.attrs, extraRedactPatterns))
      : null;
    this.db
      .prepare(`INSERT OR IGNORE INTO spans
         (span_id, trace_id, parent_span_id, kind, name, start_ts, end_ts, status, attrs)
         VALUES (?,?,?,?,?,?,?,?,?)`)
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
  closeSpan(spanId, status) {
    this.db
      .prepare(`UPDATE spans SET end_ts = ?, status = ? WHERE span_id = ?`)
      .run(Date.now(), status, spanId);
  }
  getSpans(traceId) {
    const rows = this.db
      .prepare('SELECT * FROM spans WHERE trace_id = ? ORDER BY start_ts ASC')
      .all(traceId);
    return rows.map(rowToSpan);
  }
  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  insertEvent(event, extraRedactPatterns) {
    const detailsJson = event.details
      ? JSON.stringify(redactJson(event.details, extraRedactPatterns))
      : null;
    const cause = event.cause ? redactString(event.cause, extraRedactPatterns) : null;
    this.db
      .prepare(`INSERT OR IGNORE INTO events
         (event_id, trace_id, span_id, ts, category, severity, code, cause, details)
         VALUES (?,?,?,?,?,?,?,?,?)`)
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
  getEvents(filter) {
    const conditions = [];
    const values = [];
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
    return rows.map(rowToEvent);
  }
  // ---------------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------------
  insertSnapshot(snapshot) {
    this.db
      .prepare(`INSERT OR IGNORE INTO snapshots (snapshot_id, taken_at, subject_id, body)
         VALUES (?,?,?,?)`)
      .run(snapshot.snapshotId, snapshot.takenAt, snapshot.subjectId, snapshot.body);
  }
  getSnapshot(snapshotId) {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE snapshot_id = ?').get(snapshotId);
    return row ? rowToSnapshot(row) : null;
  }
  getSnapshotsByIds(ids) {
    if (ids.length === 0) return [];
    const ph = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM snapshots WHERE snapshot_id IN (${ph})`)
      .all(...ids);
    return rows.map(rowToSnapshot);
  }
  // ---------------------------------------------------------------------------
  // Bulk queries (Wave C — support bundle + archive)
  // ---------------------------------------------------------------------------
  /** Flexible trace query for time-range and session filtering. */
  getTraces(filter) {
    const conditions = [];
    const values = [];
    if (filter.since !== undefined) {
      conditions.push('start_ts >= ?');
      values.push(filter.since);
    }
    if (filter.until !== undefined) {
      conditions.push('start_ts < ?');
      values.push(filter.until);
    }
    if (filter.sessionId !== undefined) {
      conditions.push('session_id = ?');
      values.push(filter.sessionId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const lim = filter.limit ?? 1000;
    const rows = this.db
      .prepare(`SELECT * FROM traces ${where} ORDER BY start_ts ASC LIMIT ?`)
      .all(...values, lim);
    return rows.map(rowToTrace);
  }
  /** Fetch all spans belonging to a set of trace IDs. */
  getSpansByTraceIds(traceIds) {
    if (traceIds.length === 0) return [];
    const ph = traceIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM spans WHERE trace_id IN (${ph}) ORDER BY start_ts ASC`)
      .all(...traceIds);
    return rows.map(rowToSpan);
  }
  /** Fetch all events belonging to a set of trace IDs. */
  getEventsByTraceIds(traceIds) {
    if (traceIds.length === 0) return [];
    const ph = traceIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE trace_id IN (${ph}) ORDER BY ts ASC`)
      .all(...traceIds);
    return rows.map(rowToEvent);
  }
  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  close() {
    this.db.close();
  }
}
function rowToTrace(r) {
  return {
    traceId: r.trace_id,
    sessionId: r.session_id ?? undefined,
    kind: r.kind,
    startTs: r.start_ts,
    endTs: r.end_ts ?? undefined,
    status: r.status ?? undefined,
    subjectId: r.subject_id ?? undefined,
    snapshotId: r.snapshot_id ?? undefined,
    attrs: r.attrs ? JSON.parse(r.attrs) : undefined,
  };
}
function rowToSpan(r) {
  return {
    spanId: r.span_id,
    traceId: r.trace_id,
    parentSpanId: r.parent_span_id ?? undefined,
    kind: r.kind,
    name: r.name,
    startTs: r.start_ts,
    endTs: r.end_ts ?? undefined,
    status: r.status ?? undefined,
    attrs: r.attrs ? JSON.parse(r.attrs) : undefined,
  };
}
function rowToEvent(r) {
  return {
    eventId: r.event_id,
    traceId: r.trace_id ?? undefined,
    spanId: r.span_id ?? undefined,
    ts: r.ts,
    category: r.category,
    severity: r.severity,
    code: r.code ?? undefined,
    cause: r.cause ?? undefined,
    details: r.details ? JSON.parse(r.details) : undefined,
  };
}
function rowToSnapshot(r) {
  return {
    snapshotId: r.snapshot_id,
    takenAt: r.taken_at,
    subjectId: r.subject_id,
    body: r.body,
  };
}
