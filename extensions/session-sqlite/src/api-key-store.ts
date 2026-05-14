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

export interface CreateApiKeyInput {
  name: string;
  scopes: string[];
}

export interface CreateApiKeyResult {
  /** Plaintext secret. Surface to the user ONCE, then drop the reference. */
  secret: string;
  record: ApiKeyRecord;
}

export interface ApiKeyRecord {
  id: string;
  /** First slice of the secret (`sk-ethos-XXXXXXXX`) for reference UX. */
  prefix: string;
  name: string;
  scopes: string[];
  createdAt: Date;
  lastUsed: Date | null;
  revokedAt: Date | null;
}

export class AmbiguousPrefixError extends Error {
  constructor(public readonly prefix: string) {
    super(`Multiple API keys match prefix "${prefix}". Use a longer prefix.`);
    this.name = 'AmbiguousPrefixError';
  }
}

export class SqliteApiKeyStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id          TEXT PRIMARY KEY,
        prefix      TEXT NOT NULL,
        hash        TEXT NOT NULL,
        name        TEXT NOT NULL,
        scopes      TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        last_used   TEXT,
        revoked_at  TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(hash);
      CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);
    `);
  }

  async create(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
    const { secret, prefix } = generateSecret();
    const id = randomUUID();
    const now = new Date().toISOString();
    const hash = hashApiKey(secret);
    const scopes = input.scopes.join(',');

    this.db
      .prepare(
        `INSERT INTO api_keys (id, prefix, hash, name, scopes, created_at, last_used, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(id, prefix, hash, input.name, scopes, now);

    return {
      secret,
      record: {
        id,
        prefix,
        name: input.name,
        scopes: [...input.scopes],
        createdAt: new Date(now),
        lastUsed: null,
        revokedAt: null,
      },
    };
  }

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM api_keys WHERE hash = ? AND revoked_at IS NULL LIMIT 1')
      .get(hash);
    return row ? rowToRecord(row as ApiKeyRow) : null;
  }

  async list(): Promise<ApiKeyRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM api_keys ORDER BY created_at DESC')
      .all() as ApiKeyRow[];
    return rows.map(rowToRecord);
  }

  async revoke(prefix: string): Promise<ApiKeyRecord | null> {
    const matches = this.db
      .prepare('SELECT * FROM api_keys WHERE prefix LIKE ? AND revoked_at IS NULL')
      .all(`${prefix}%`) as ApiKeyRow[];

    if (matches.length === 0) return null;
    if (matches.length > 1) throw new AmbiguousPrefixError(prefix);

    const target = matches[0];
    if (!target) return null;
    const now = new Date().toISOString();
    this.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(now, target.id);
    return rowToRecord({ ...target, revoked_at: now });
  }

  async touchLastUsed(id: string): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE api_keys SET last_used = ? WHERE id = ?').run(now, id);
  }

  close(): void {
    this.db.close();
  }
}

export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

interface ApiKeyRow {
  id: string;
  prefix: string;
  hash: string;
  name: string;
  scopes: string;
  created_at: string;
  last_used: string | null;
  revoked_at: string | null;
}

function rowToRecord(r: ApiKeyRow): ApiKeyRecord {
  return {
    id: r.id,
    prefix: r.prefix,
    name: r.name,
    scopes: r.scopes
      ? r.scopes
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    createdAt: new Date(r.created_at),
    lastUsed: r.last_used ? new Date(r.last_used) : null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at) : null,
  };
}

function generateSecret(): { secret: string; prefix: string } {
  const prefixRandom = randomBytes(PREFIX_BYTES).toString('hex');
  const bodyRandom = randomBytes(SECRET_BYTES).toString('hex');
  const prefix = `${KEY_PREFIX}${prefixRandom}`;
  const secret = `${prefix}${bodyRandom}`;
  return { secret, prefix };
}
