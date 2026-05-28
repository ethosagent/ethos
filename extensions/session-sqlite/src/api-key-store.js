import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

// SqliteApiKeyStore — bearer-token store backing /v1/* on the OpenAI-compat
// surface. Lives alongside SQLiteSessionStore so a single sessions.db file
// holds both conversation state and API credentials. The table is created
// idempotently on construction so the CLI command (which doesn't need a
// SessionStore) can stand the table up on first run.
//
// The full secret never touches disk — only its sha256 hash. The `prefix`
// column is the first slice of the secret, kept in cleartext so the
// dashboard / CLI can reference a key without the user pasting the full
// value (`ethos api-key revoke <prefix>`).
const KEY_PREFIX = 'sk-ethos-';
const PREFIX_BYTES = 4; // 8 hex chars after the literal `sk-ethos-`
const SECRET_BYTES = 28; // 56 hex chars of random — 224 bits of entropy
export class AmbiguousPrefixError extends Error {
  prefix;
  constructor(prefix) {
    super(`Multiple API keys match prefix "${prefix}". Use a longer prefix.`);
    this.prefix = prefix;
    this.name = 'AmbiguousPrefixError';
  }
}
export class SqliteApiKeyStore {
  db;
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id              TEXT PRIMARY KEY,
        prefix          TEXT NOT NULL,
        hash            TEXT NOT NULL,
        name            TEXT NOT NULL,
        scopes          TEXT NOT NULL,
        allowed_origins TEXT NOT NULL DEFAULT '[]',
        created_at      TEXT NOT NULL,
        last_used       TEXT,
        revoked_at      TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(hash);
      CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);
    `);
    // Additive migration: add allowed_origins column if table predates it.
    const cols = this.db.pragma('table_info(api_keys)');
    if (!cols.some((c) => c.name === 'allowed_origins')) {
      this.db.exec(`ALTER TABLE api_keys ADD COLUMN allowed_origins TEXT NOT NULL DEFAULT '[]'`);
    }
  }
  async create(input) {
    const { secret, prefix } = generateSecret();
    const id = randomUUID();
    const now = new Date().toISOString();
    const hash = hashApiKey(secret);
    const scopes = input.scopes.join(',');
    const origins = JSON.stringify(input.allowedOrigins ?? []);
    this.db
      .prepare(`INSERT INTO api_keys (id, prefix, hash, name, scopes, allowed_origins, created_at, last_used, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
      .run(id, prefix, hash, input.name, scopes, origins, now);
    return {
      secret,
      record: {
        id,
        prefix,
        name: input.name,
        scopes: [...input.scopes],
        allowedOrigins: [...(input.allowedOrigins ?? [])],
        createdAt: new Date(now),
        lastUsed: null,
        revokedAt: null,
      },
    };
  }
  async findByHash(hash) {
    const row = this.db
      .prepare('SELECT * FROM api_keys WHERE hash = ? AND revoked_at IS NULL LIMIT 1')
      .get(hash);
    return row ? rowToRecord(row) : null;
  }
  async list() {
    const rows = this.db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all();
    return rows.map(rowToRecord);
  }
  async revoke(prefix) {
    const matches = this.db
      .prepare('SELECT * FROM api_keys WHERE prefix LIKE ? AND revoked_at IS NULL')
      .all(`${prefix}%`);
    if (matches.length === 0) return null;
    if (matches.length > 1) throw new AmbiguousPrefixError(prefix);
    const target = matches[0];
    if (!target) return null;
    const now = new Date().toISOString();
    this.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(now, target.id);
    return rowToRecord({ ...target, revoked_at: now });
  }
  async touchLastUsed(id) {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE api_keys SET last_used = ? WHERE id = ?').run(now, id);
  }
  close() {
    this.db.close();
  }
}
export function hashApiKey(secret) {
  return createHash('sha256').update(secret).digest('hex');
}
function splitCsv(raw) {
  return raw
    ? raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}
function parseOrigins(raw) {
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  // Legacy CSV fallback for rows written before JSON migration.
  return splitCsv(raw);
}
function rowToRecord(r) {
  return {
    id: r.id,
    prefix: r.prefix,
    name: r.name,
    scopes: splitCsv(r.scopes),
    allowedOrigins: parseOrigins(r.allowed_origins),
    createdAt: new Date(r.created_at),
    lastUsed: r.last_used ? new Date(r.last_used) : null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at) : null,
  };
}
function generateSecret() {
  const prefixRandom = randomBytes(PREFIX_BYTES).toString('hex');
  const bodyRandom = randomBytes(SECRET_BYTES).toString('hex');
  const prefix = `${KEY_PREFIX}${prefixRandom}`;
  const secret = `${prefix}${bodyRandom}`;
  return { secret, prefix };
}
