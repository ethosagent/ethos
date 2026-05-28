export class SqliteKeyValueStore {
  db;
  tool;
  scopeId;
  constructor(db, tool, scopeId) {
    this.db = db;
    this.tool = tool;
    this.scopeId = scopeId;
  }
  static migrate(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_kv (
        tool       TEXT NOT NULL,
        scope_id   TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (tool, scope_id, key)
      ) STRICT;
    `);
  }
  async get(key) {
    const row = this.db
      .prepare(`SELECT value FROM tool_kv
         WHERE tool = ? AND scope_id = ? AND key = ?
           AND (expires_at IS NULL OR expires_at > ?)`)
      .get(this.tool, this.scopeId, key, Date.now());
    return row?.value ?? null;
  }
  async set(key, value, opts) {
    const expiresAt = opts?.ttlSeconds != null ? Date.now() + opts.ttlSeconds * 1000 : null;
    this.db
      .prepare(`INSERT OR REPLACE INTO tool_kv (tool, scope_id, key, value, expires_at)
         VALUES (?, ?, ?, ?, ?)`)
      .run(this.tool, this.scopeId, key, value, expiresAt);
  }
  async delete(key) {
    this.db
      .prepare('DELETE FROM tool_kv WHERE tool = ? AND scope_id = ? AND key = ?')
      .run(this.tool, this.scopeId, key);
  }
  async list(prefix) {
    const escaped = prefix.replace(/[%_\\]/g, '\\$&');
    const rows = this.db
      .prepare(`SELECT DISTINCT key FROM tool_kv
         WHERE tool = ? AND scope_id = ? AND key LIKE ? ESCAPE '\\'
           AND (expires_at IS NULL OR expires_at > ?)`)
      .all(this.tool, this.scopeId, `${escaped}%`, Date.now());
    return rows.map((r) => r.key);
  }
}
