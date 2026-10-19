import { randomUUID } from 'node:crypto';
import Database from '@ethosagent/sqlite';
import type { UsageRecord, UsageRecorder } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// SQLiteUsageLedger
//
// One row per model call made outside a turn's own `streamStep` call
// (plan/phases/background-usage-accounting.md §4.2, D1–D3). A separate class on
// its OWN handle to `sessions.db`, the `SQLiteContextLog` pattern (D3):
// `synchronous` is per connection, so the durability posture is read off this
// handle, and the recorder shares no write path with `SQLiteSessionStore`.
//
// `synchronous` is deliberately left at SQLite's FULL default (D2): the bot daily
// cap reads these rows, so a power cut dropping the tail would under-count a
// guarantee made to the operator. Not hot — a handful of commits per turn beside
// an LLM call that takes seconds. Pinned by 'durability posture' in
// `__tests__/usage-ledger.test.ts`.
//
// The table is created with `CREATE TABLE IF NOT EXISTS … STRICT` outside the
// `user_version` baseline, like `session_context_events`: idempotent, no version
// bump (an older binary never reads it and under-reports, as today). No FK on
// `session_id`: ephemeral and pruned sessions must not orphan or block a row.
// ---------------------------------------------------------------------------

export const USAGE_LEDGER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS usage_ledger (
    id                    TEXT PRIMARY KEY,
    ts                    TEXT NOT NULL,
    source_kind           TEXT NOT NULL,
    source_class          TEXT NOT NULL,
    source_ref            TEXT,
    personality_id        TEXT,
    bot_key               TEXT,
    platform              TEXT,
    session_id            TEXT,
    session_key           TEXT,
    trace_id              TEXT,
    provider              TEXT NOT NULL,
    model                 TEXT NOT NULL,
    input_tokens          INTEGER NOT NULL,
    output_tokens         INTEGER NOT NULL,
    cache_read_tokens     INTEGER NOT NULL,
    cache_creation_tokens INTEGER NOT NULL,
    estimated_cost_usd    REAL    NOT NULL,
    cost_basis            TEXT,
    outcome               TEXT    NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_usage_ledger_ts  ON usage_ledger(ts);
  CREATE INDEX IF NOT EXISTS idx_usage_ledger_bot ON usage_ledger(bot_key, ts);
`;

/** Non-turn spend since a point, split by who caused it (plan §7.1). */
export interface LedgerSpend {
  turnUtilityUsd: number;
  backgroundUsd: number;
  operatorUsd: number;
}

export class SQLiteUsageLedger implements UsageRecorder {
  private readonly db: Database.Database;
  private readonly insert: ReturnType<Database.Database['prepare']>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    // sessions.db is shared cross-process (gateway + serve + CLI): wait, don't throw SQLITE_BUSY.
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(USAGE_LEDGER_SCHEMA);
    this.insert = this.db.prepare(
      `INSERT INTO usage_ledger (
         id, ts, source_kind, source_class, source_ref, personality_id, bot_key, platform,
         session_id, session_key, trace_id, provider, model, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, estimated_cost_usd, cost_basis, outcome
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  /** One autocommit INSERT. May throw — the metering decorator fails open (§4.3). */
  record(row: UsageRecord): void {
    this.insert.run(
      randomUUID(),
      row.ts,
      row.kind,
      row.sourceClass,
      row.sourceRef ?? null,
      row.personalityId ?? null,
      row.botKey ?? null,
      row.platform ?? null,
      row.sessionId ?? null,
      row.sessionKey ?? null,
      row.traceId ?? null,
      row.provider,
      row.model,
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheCreationTokens,
      row.estimatedCostUsd,
      row.costBasis ?? null,
      row.outcome,
    );
  }

  /**
   * Spend recorded at or after `since`, by source class. With `botKey` and/or
   * `keyPrefix` a row counts when it matches EITHER (one `OR` in one query, so a
   * row matching both is counted once). `keyPrefix` is an exact, case-sensitive
   * `substr` comparison, not `LIKE` (see `usageAggregate`). Neither → every row.
   */
  spendSince(opts: { since: Date; botKey?: string; keyPrefix?: string }): LedgerSpend {
    const scopes: string[] = [];
    const params: unknown[] = [opts.since.toISOString()];
    if (opts.botKey !== undefined) {
      scopes.push('bot_key = ?');
      params.push(opts.botKey);
    }
    if (opts.keyPrefix !== undefined) {
      scopes.push('substr(session_key, 1, length(?)) = ?');
      params.push(opts.keyPrefix, opts.keyPrefix);
    }
    const scope = scopes.length > 0 ? `AND (${scopes.join(' OR ')})` : '';
    const sums: LedgerSpend = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN source_class = 'turn_utility' THEN estimated_cost_usd ELSE 0 END), 0) AS turnUtilityUsd,
           COALESCE(SUM(CASE WHEN source_class = 'background' THEN estimated_cost_usd ELSE 0 END), 0) AS backgroundUsd,
           COALESCE(SUM(CASE WHEN source_class = 'operator' THEN estimated_cost_usd ELSE 0 END), 0) AS operatorUsd
         FROM usage_ledger WHERE ts >= ? ${scope}`,
      )
      .get(...params);
    return { ...sums };
  }

  close(): void {
    this.db.close();
  }
}
