import type { RetentionConfig } from '@ethosagent/types';
import BetterSqlite3 from 'better-sqlite3';

/** Parse a duration string to milliseconds, or null for 'forever'. */
export function parseDuration(s: string): number | null {
  if (s === 'forever') return null;
  const m = s.match(/^(\d+)(d|w|m|y)$/);
  if (!m) throw new Error(`Invalid duration: "${s}"`);
  const n = Number(m[1]);
  switch (m[2]) {
    case 'd':
      return n * 86_400_000;
    case 'w':
      return n * 7 * 86_400_000;
    case 'm':
      return n * 30 * 86_400_000;
    case 'y':
      return n * 365 * 86_400_000;
    default:
      throw new Error(`Unknown unit in "${s}"`);
  }
}

/** Deep-merge a sparse per-personality override on top of the global config. */
export function mergeRetentionConfig(
  global: RetentionConfig,
  override?: RetentionConfig,
): RetentionConfig {
  if (!override) return global;
  return {
    ...global,
    ...override,
    events: override.events ? { ...global.events, ...override.events } : global.events,
  };
}

export interface PruneResult {
  traces: number;
  spans: number;
  events: number;
  snapshots: number;
  messages: number;
}

/**
 * Prune rows from observability.db that have exceeded their retention TTL.
 * Returns counts of deleted rows (or would-delete counts when dryRun=true).
 */
export function pruneObservability(
  db: BetterSqlite3.Database,
  config: RetentionConfig,
  opts: {
    dryRun?: boolean;
    now?: number;
    sessDb?: BetterSqlite3.Database;
    personalityId?: string;
    /** Personality IDs to exclude from the global pass (they have per-personality passes). */
    excludePersonalityIds?: string[];
  } = {},
): PruneResult {
  const now = opts.now ?? Date.now();
  const result: PruneResult = { traces: 0, spans: 0, events: 0, snapshots: 0, messages: 0 };

  const cutoff = (dur: string | undefined, def: string) => parseDuration(dur ?? def);

  const traceCutoff = cutoff(config.traces, '90d');
  const spanCutoff = cutoff(config.spans, '90d');

  // Personalities that have their own prune pass — excluded from the global pass
  // so a stricter global TTL cannot delete rows that a personality should retain.
  const excluded = opts.excludePersonalityIds ?? [];

  if (traceCutoff !== null) {
    const threshold = now - traceCutoff;
    if (opts.personalityId) {
      if (opts.dryRun) {
        result.traces = (
          db
            .prepare('SELECT COUNT(*) as n FROM traces WHERE personality_id = ? AND start_ts < ?')
            .get(opts.personalityId, threshold) as { n: number }
        ).n;
      } else {
        result.traces = db
          .prepare('DELETE FROM traces WHERE personality_id = ? AND start_ts < ?')
          .run(opts.personalityId, threshold).changes;
      }
    } else if (excluded.length > 0) {
      const ph = excluded.map(() => '?').join(',');
      if (opts.dryRun) {
        result.traces = (
          db
            .prepare(
              `SELECT COUNT(*) as n FROM traces WHERE start_ts < ? AND (personality_id IS NULL OR personality_id NOT IN (${ph}))`,
            )
            .get(threshold, ...excluded) as { n: number }
        ).n;
      } else {
        result.traces = db
          .prepare(
            `DELETE FROM traces WHERE start_ts < ? AND (personality_id IS NULL OR personality_id NOT IN (${ph}))`,
          )
          .run(threshold, ...excluded).changes;
      }
    } else if (opts.dryRun) {
      result.traces = (
        db.prepare('SELECT COUNT(*) as n FROM traces WHERE start_ts < ?').get(threshold) as {
          n: number;
        }
      ).n;
    } else {
      result.traces = db.prepare('DELETE FROM traces WHERE start_ts < ?').run(threshold).changes;
    }
  }

  if (spanCutoff !== null) {
    const threshold = now - spanCutoff;
    if (opts.personalityId) {
      if (opts.dryRun) {
        result.spans = (
          db
            .prepare(
              'SELECT COUNT(*) as n FROM spans WHERE trace_id IN (SELECT trace_id FROM traces WHERE personality_id = ? AND start_ts < ?)',
            )
            .get(opts.personalityId, threshold) as { n: number }
        ).n;
      } else {
        result.spans = db
          .prepare(
            'DELETE FROM spans WHERE trace_id IN (SELECT trace_id FROM traces WHERE personality_id = ? AND start_ts < ?)',
          )
          .run(opts.personalityId, threshold).changes;
      }
    } else if (excluded.length > 0) {
      const ph = excluded.map(() => '?').join(',');
      if (opts.dryRun) {
        result.spans = (
          db
            .prepare(
              `SELECT COUNT(*) as n FROM spans WHERE start_ts < ? AND trace_id NOT IN (SELECT trace_id FROM traces WHERE personality_id IN (${ph}))`,
            )
            .get(threshold, ...excluded) as { n: number }
        ).n;
      } else {
        result.spans = db
          .prepare(
            `DELETE FROM spans WHERE start_ts < ? AND trace_id NOT IN (SELECT trace_id FROM traces WHERE personality_id IN (${ph}))`,
          )
          .run(threshold, ...excluded).changes;
      }
    } else if (opts.dryRun) {
      result.spans = (
        db.prepare('SELECT COUNT(*) as n FROM spans WHERE start_ts < ?').get(threshold) as {
          n: number;
        }
      ).n;
    } else {
      result.spans = db.prepare('DELETE FROM spans WHERE start_ts < ?').run(threshold).changes;
    }
  }

  // Events: per-category cutoffs
  const categories: Array<[string, string]> = [
    ['error', config.events?.error ?? '90d'],
    ['audit.%', config.events?.audit ?? '365d'],
    ['channel.%', config.events?.channel ?? '365d'],
    ['install.%', config.events?.install ?? 'forever'],
  ];

  for (const [pat, dur] of categories) {
    const ms = parseDuration(dur);
    if (ms === null) continue;
    const threshold = now - ms;
    const likeOp = pat.includes('%') ? 'LIKE' : '=';
    if (opts.personalityId) {
      if (opts.dryRun) {
        result.events += (
          db
            .prepare(
              `SELECT COUNT(*) as n FROM events WHERE category ${likeOp} ? AND ts < ? AND (trace_id IS NULL OR trace_id IN (SELECT trace_id FROM traces WHERE personality_id = ?))`,
            )
            .get(pat, threshold, opts.personalityId) as { n: number }
        ).n;
      } else {
        result.events += db
          .prepare(
            `DELETE FROM events WHERE category ${likeOp} ? AND ts < ? AND (trace_id IS NULL OR trace_id IN (SELECT trace_id FROM traces WHERE personality_id = ?))`,
          )
          .run(pat, threshold, opts.personalityId).changes;
      }
    } else if (excluded.length > 0) {
      const ph = excluded.map(() => '?').join(',');
      if (opts.dryRun) {
        result.events += (
          db
            .prepare(
              `SELECT COUNT(*) as n FROM events WHERE category ${likeOp} ? AND ts < ? AND (trace_id IS NULL OR trace_id NOT IN (SELECT trace_id FROM traces WHERE personality_id IN (${ph})))`,
            )
            .get(pat, threshold, ...excluded) as { n: number }
        ).n;
      } else {
        result.events += db
          .prepare(
            `DELETE FROM events WHERE category ${likeOp} ? AND ts < ? AND (trace_id IS NULL OR trace_id NOT IN (SELECT trace_id FROM traces WHERE personality_id IN (${ph})))`,
          )
          .run(pat, threshold, ...excluded).changes;
      }
    } else if (opts.dryRun) {
      result.events += (
        db
          .prepare(`SELECT COUNT(*) as n FROM events WHERE category ${likeOp} ? AND ts < ?`)
          .get(pat, threshold) as { n: number }
      ).n;
    } else {
      result.events += db
        .prepare(`DELETE FROM events WHERE category ${likeOp} ? AND ts < ?`)
        .run(pat, threshold).changes;
    }
  }

  // Snapshots: prune orphaned snapshots (no referenced trace) — global-only
  if (!opts.personalityId && !opts.dryRun) {
    result.snapshots = db
      .prepare(
        'DELETE FROM snapshots WHERE snapshot_id NOT IN (SELECT DISTINCT snapshot_id FROM traces WHERE snapshot_id IS NOT NULL)',
      )
      .run().changes;
  }

  // Messages (sessions.db — separate DB, passed in as sessDb).
  // Not personality-scoped: messages table has no personality_id column.
  // Only run in the global pass (not per-personality passes).
  if (opts.sessDb && !opts.personalityId) {
    const msgCutoff = cutoff(config.messages, '365d');
    if (msgCutoff !== null) {
      const threshold = now - msgCutoff;
      // messages.timestamp is an ISO-8601 TEXT column; convert threshold to ISO for comparison.
      const iso = new Date(threshold).toISOString();
      if (opts.dryRun) {
        result.messages = (
          opts.sessDb
            .prepare('SELECT COUNT(*) as n FROM messages WHERE timestamp < ?')
            .get(iso) as { n: number }
        ).n;
      } else {
        result.messages = opts.sessDb
          .prepare('DELETE FROM messages WHERE timestamp < ?')
          .run(iso).changes;
      }
    }
  }

  return result;
}

/**
 * Convenience wrapper: open a SQLite database by path, prune it, then close.
 * Lets callers (e.g. the CLI `data prune` command) avoid importing better-sqlite3
 * directly when they only have a file path.
 */
export function pruneObservabilityByPath(
  dbPath: string,
  config: RetentionConfig,
  opts: {
    dryRun?: boolean;
    now?: number;
    sessDbPath?: string;
    personalityId?: string;
    excludePersonalityIds?: string[];
  } = {},
): PruneResult {
  const db = new BetterSqlite3(dbPath);
  let sessDb: BetterSqlite3.Database | undefined;
  if (opts.sessDbPath) {
    sessDb = new BetterSqlite3(opts.sessDbPath);
  }
  try {
    return pruneObservability(db, config, { ...opts, sessDb });
  } finally {
    sessDb?.close();
    db.close();
  }
}

/**
 * Get SQLite page statistics for a database file.
 * Returns null if the file cannot be opened.
 */
export function getSqliteStats(
  dbPath: string,
): { pageCount: number; pageSize: number; totalBytes: number } | null {
  let db: BetterSqlite3.Database | null = null;
  try {
    db = new BetterSqlite3(dbPath, { readonly: true });
    const pageCount = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
    const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
    return { pageCount, pageSize, totalBytes: pageCount * pageSize };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
