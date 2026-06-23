import Database from '@ethosagent/sqlite';

export interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const TTL_SECONDS = 86_400; // 24 hours
const SWEEP_INTERVAL_MS = 60_000 * 15; // sweep at most every 15 minutes

export class IdempotencyStore {
  private readonly db: Database.Database;
  private lastSweepAt = 0;

  constructor(dbPathOrDb: string | Database.Database) {
    this.db = typeof dbPathOrDb === 'string' ? new Database(dbPathOrDb) : dbPathOrDb;
    if (typeof dbPathOrDb === 'string') this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency_cache (
        api_key_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status INTEGER NOT NULL,
        headers_json TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (api_key_hash, idempotency_key)
      ) STRICT
    `);
  }

  get(apiKeyHash: string, key: string): (CachedResponse & { requestHash: string }) | null {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db
      .prepare(
        `SELECT request_hash, status, headers_json, body FROM idempotency_cache
         WHERE api_key_hash = ? AND idempotency_key = ? AND created_at > ?`,
      )
      .get(apiKeyHash, key, now - TTL_SECONDS) as
      | { request_hash: string; status: number; headers_json: string; body: string }
      | undefined;
    if (!row) return null;
    return {
      requestHash: row.request_hash,
      status: row.status,
      headers: JSON.parse(row.headers_json) as Record<string, string>,
      body: row.body,
    };
  }

  set(apiKeyHash: string, key: string, requestHash: string, response: CachedResponse): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO idempotency_cache
         (api_key_hash, idempotency_key, request_hash, status, headers_json, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        apiKeyHash,
        key,
        requestHash,
        response.status,
        JSON.stringify(response.headers),
        response.body,
        now,
      );
    this.maybeSweep();
  }

  private maybeSweep(): void {
    const now = Date.now();
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;
    this.sweep();
  }

  sweep(): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare('DELETE FROM idempotency_cache WHERE created_at <= ?').run(now - TTL_SECONDS);
  }

  close(): void {
    this.db.close();
  }
}
