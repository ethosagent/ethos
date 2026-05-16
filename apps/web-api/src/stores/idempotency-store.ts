import Database from 'better-sqlite3';

export interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const TTL_SECONDS = 86_400; // 24 hours

export class IdempotencyStore {
  private readonly db: Database.Database;

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
        status INTEGER NOT NULL,
        headers_json TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (api_key_hash, idempotency_key)
      ) STRICT
    `);
  }

  get(apiKeyHash: string, key: string): CachedResponse | null {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db
      .prepare(
        `SELECT status, headers_json, body FROM idempotency_cache
         WHERE api_key_hash = ? AND idempotency_key = ? AND created_at > ?`,
      )
      .get(apiKeyHash, key, now - TTL_SECONDS) as
      | { status: number; headers_json: string; body: string }
      | undefined;
    if (!row) return null;
    return {
      status: row.status,
      headers: JSON.parse(row.headers_json) as Record<string, string>,
      body: row.body,
    };
  }

  set(apiKeyHash: string, key: string, response: CachedResponse): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO idempotency_cache
         (api_key_hash, idempotency_key, status, headers_json, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(apiKeyHash, key, response.status, JSON.stringify(response.headers), response.body, now);
  }

  sweep(): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare('DELETE FROM idempotency_cache WHERE created_at <= ?')
      .run(now - TTL_SECONDS);
  }

  close(): void {
    this.db.close();
  }
}
