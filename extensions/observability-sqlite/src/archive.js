import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { createTarGz, readTarGz } from './tar-bundle';

/** Compute epoch-ms bounds [since, until) for a 'YYYY-MM' month string. */
function monthBounds(month) {
  const parts = month.split('-');
  const year = Number(parts[0]);
  const mon = Number(parts[1]) - 1; // 0-indexed
  return {
    since: new Date(year, mon, 1).getTime(),
    until: new Date(year, mon + 1, 1).getTime(),
  };
}
function parseJsonl(buf) {
  if (!buf || buf.length === 0) return [];
  return buf
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
/**
 * Archive all completed traces from a given 'YYYY-MM' month into
 * `archiveDir/<month>.tar.gz`, then delete those rows from the live DB.
 *
 * The tarball is base64-encoded when written through Storage (Storage only
 * supports UTF-8 text). `restoreArchive` decodes it symmetrically.
 */
export async function archiveMonth(dbPath, storage, archiveDir, month) {
  const db = new BetterSqlite3(dbPath);
  try {
    const { since, until } = monthBounds(month);
    const traces = db
      .prepare('SELECT * FROM traces WHERE start_ts >= ? AND start_ts < ? AND end_ts IS NOT NULL')
      .all(since, until);
    if (traces.length === 0) return { traces: 0, spans: 0, events: 0, snapshots: 0 };
    const traceIds = traces.map((t) => String(t.trace_id));
    const ph = traceIds.map(() => '?').join(',');
    const spans = db.prepare(`SELECT * FROM spans WHERE trace_id IN (${ph})`).all(...traceIds);
    const events = db.prepare(`SELECT * FROM events WHERE trace_id IN (${ph})`).all(...traceIds);
    const snapshotIds = [...new Set(traces.map((t) => t.snapshot_id).filter(Boolean))];
    const snapshots =
      snapshotIds.length > 0
        ? db
            .prepare(
              `SELECT * FROM snapshots WHERE snapshot_id IN (${snapshotIds.map(() => '?').join(',')})`,
            )
            .all(...snapshotIds)
        : [];
    const files = new Map();
    files.set('traces.jsonl', Buffer.from(traces.map((r) => JSON.stringify(r)).join('\n'), 'utf8'));
    files.set('spans.jsonl', Buffer.from(spans.map((r) => JSON.stringify(r)).join('\n'), 'utf8'));
    files.set('events.jsonl', Buffer.from(events.map((r) => JSON.stringify(r)).join('\n'), 'utf8'));
    files.set(
      'snapshots.jsonl',
      Buffer.from(snapshots.map((r) => JSON.stringify(r)).join('\n'), 'utf8'),
    );
    files.set(
      'manifest.json',
      Buffer.from(
        JSON.stringify({
          month,
          archivedAt: Date.now(),
          traces: traces.length,
          spans: spans.length,
          events: events.length,
          snapshots: snapshots.length,
        }),
        'utf8',
      ),
    );
    const tarGz = createTarGz(files);
    const archivePath = join(archiveDir, `${month}.tar.gz`);
    await storage.mkdir(archiveDir);
    // Storage is UTF-8 text only; base64-encode the binary tarball.
    await storage.writeAtomic(archivePath, tarGz.toString('base64'));
    // Verify the archive was written correctly before deleting live rows.
    const written = await storage.read(archivePath);
    if (written === null)
      throw new Error(`Archive write verification failed: ${archivePath} not found`);
    const verified = readTarGz(Buffer.from(written, 'base64'));
    const verifiedTraceCount =
      verified.get('traces.jsonl')?.toString('utf8').split('\n').filter(Boolean).length ?? 0;
    if (verifiedTraceCount !== traces.length) {
      throw new Error(
        `Archive integrity check failed: expected ${traces.length} traces, archive contains ${verifiedTraceCount}`,
      );
    }
    // Delete archived rows in a single transaction.
    db.transaction(() => {
      db.prepare(`DELETE FROM events WHERE trace_id IN (${ph})`).run(...traceIds);
      db.prepare(`DELETE FROM spans WHERE trace_id IN (${ph})`).run(...traceIds);
      db.prepare(`DELETE FROM traces WHERE trace_id IN (${ph})`).run(...traceIds);
      db.prepare(
        'DELETE FROM snapshots WHERE snapshot_id NOT IN (SELECT DISTINCT snapshot_id FROM traces WHERE snapshot_id IS NOT NULL)',
      ).run();
    })();
    return {
      traces: traces.length,
      spans: spans.length,
      events: events.length,
      snapshots: snapshots.length,
    };
  } finally {
    db.close();
  }
}
/**
 * Restore a previously archived month back into the live DB.
 * Rows already present (same primary key) are silently skipped.
 */
export async function restoreArchive(dbPath, storage, archiveDir, month) {
  const archivePath = join(archiveDir, `${month}.tar.gz`);
  const raw = await storage.read(archivePath);
  if (!raw) throw new Error(`Archive not found: ${month}.tar.gz`);
  const files = readTarGz(Buffer.from(raw, 'base64'));
  const db = new BetterSqlite3(dbPath);
  try {
    const result = { traces: 0, spans: 0, events: 0, snapshots: 0 };
    const traces = parseJsonl(files.get('traces.jsonl'));
    const spans = parseJsonl(files.get('spans.jsonl'));
    const events = parseJsonl(files.get('events.jsonl'));
    const snapshots = parseJsonl(files.get('snapshots.jsonl'));
    db.transaction(() => {
      const insertTrace = db.prepare(
        'INSERT OR IGNORE INTO traces (trace_id, session_id, kind, start_ts, end_ts, status, subject_id, snapshot_id, attrs) VALUES (?,?,?,?,?,?,?,?,?)',
      );
      const insertSpan = db.prepare(
        'INSERT OR IGNORE INTO spans (span_id, trace_id, parent_span_id, kind, name, start_ts, end_ts, status, attrs) VALUES (?,?,?,?,?,?,?,?,?)',
      );
      const insertEvent = db.prepare(
        'INSERT OR IGNORE INTO events (event_id, trace_id, span_id, ts, category, severity, code, cause, details) VALUES (?,?,?,?,?,?,?,?,?)',
      );
      const insertSnapshot = db.prepare(
        'INSERT OR IGNORE INTO snapshots (snapshot_id, taken_at, subject_id, body) VALUES (?,?,?,?)',
      );
      for (const t of traces) {
        insertTrace.run(
          t.trace_id,
          t.session_id ?? null,
          t.kind,
          t.start_ts,
          t.end_ts ?? null,
          t.status ?? null,
          // Pre-rename archives stored `personality_id`; accept either key.
          t.subject_id ?? t.personality_id ?? null,
          t.snapshot_id ?? null,
          t.attrs ?? null,
        );
        result.traces++;
      }
      for (const s of spans) {
        insertSpan.run(
          s.span_id,
          s.trace_id,
          s.parent_span_id ?? null,
          s.kind,
          s.name,
          s.start_ts,
          s.end_ts ?? null,
          s.status ?? null,
          s.attrs ?? null,
        );
        result.spans++;
      }
      for (const e of events) {
        insertEvent.run(
          e.event_id,
          e.trace_id ?? null,
          e.span_id ?? null,
          e.ts,
          e.category,
          e.severity,
          e.code ?? null,
          e.cause ?? null,
          e.details ?? null,
        );
        result.events++;
      }
      for (const snap of snapshots) {
        insertSnapshot.run(
          snap.snapshot_id,
          snap.taken_at,
          // Pre-rename archives stored `personality_id`; accept either key.
          snap.subject_id ?? snap.personality_id,
          snap.body,
        );
        result.snapshots++;
      }
    })();
    return result;
  } finally {
    db.close();
  }
}
/**
 * List archive tarballs in `archiveDir`, sorted chronologically (oldest first).
 */
export async function listArchives(storage, archiveDir) {
  const names = await storage.list(archiveDir);
  return names
    .filter((n) => /^\d{4}-\d{2}\.tar\.gz$/.test(n))
    .sort()
    .map((n) => ({ month: n.replace('.tar.gz', ''), path: join(archiveDir, n) }));
}
/**
 * Remove archive files whose month ended before `olderThanMs` milliseconds ago.
 * Returns the count of files removed.
 */
export async function pruneArchives(storage, archiveDir, olderThanMs) {
  const entries = await listArchives(storage, archiveDir);
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const { month, path } of entries) {
    const parts = month.split('-');
    // The end-of-month timestamp: first ms of the following month.
    const endOfMonth = new Date(Number(parts[0]), Number(parts[1]), 1).getTime();
    if (endOfMonth < cutoff) {
      await storage.remove(path);
      removed++;
    }
  }
  return removed;
}
