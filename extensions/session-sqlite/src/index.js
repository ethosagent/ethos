import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { SqliteKeyValueStore } from './kv-store';
export { AmbiguousPrefixError, hashApiKey, SqliteApiKeyStore, } from './api-key-store';
export { decideMigration, migrateSessionKeys, } from './session-key-migration';
export { SqliteKeyValueStore };
// ---------------------------------------------------------------------------
// SQLiteSessionStore
// WAL mode + FTS5 full-text search via external-content virtual table.
// ---------------------------------------------------------------------------
export function createKvStoreFactory(dbPath) {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    SqliteKeyValueStore.migrate(db);
    return (tool, scopeId) => new SqliteKeyValueStore(db, tool, scopeId);
}
export class SQLiteSessionStore {
    db;
    constructor(dbPath) {
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.migrate();
    }
    // ---------------------------------------------------------------------------
    // Schema
    // ---------------------------------------------------------------------------
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id                   TEXT PRIMARY KEY,
        key                  TEXT UNIQUE NOT NULL,
        platform             TEXT NOT NULL,
        model                TEXT NOT NULL,
        provider             TEXT NOT NULL,
        personality_id       TEXT,
        parent_session_id    TEXT,
        working_dir          TEXT,
        title                TEXT,
        input_tokens         INTEGER NOT NULL DEFAULT 0,
        output_tokens        INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd   REAL NOT NULL DEFAULT 0,
        api_call_count       INTEGER NOT NULL DEFAULT 0,
        compaction_count     INTEGER NOT NULL DEFAULT 0,
        metadata             TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_sessions_key ON sessions(key);
      CREATE INDEX IF NOT EXISTS idx_sessions_platform ON sessions(platform);

      CREATE TABLE IF NOT EXISTS messages (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role         TEXT NOT NULL,
        content      TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name    TEXT,
        tool_calls   TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_creation_tokens INTEGER,
        estimated_cost_usd REAL,
        timestamp    TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='rowid',
        tokenize='porter ascii'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TABLE IF NOT EXISTS compressions (
        id                TEXT PRIMARY KEY,
        session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        created_at        TEXT NOT NULL,
        engine_name       TEXT NOT NULL,
        original_count    INTEGER NOT NULL,
        kept_count        INTEGER NOT NULL,
        summary_text      TEXT,
        summary_tokens    INTEGER NOT NULL,
        pre_total_tokens  INTEGER NOT NULL,
        post_total_tokens INTEGER NOT NULL,
        duration_ms       INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_compressions_session ON compressions(session_id, created_at);
    `);
        // Additive migration: soft-reference trace_id column on messages.
        // Idempotent — only adds the column when it does not already exist.
        const cols = this.db.pragma('table_info(messages)');
        if (!cols.some((c) => c.name === 'trace_id')) {
            this.db.exec('ALTER TABLE messages ADD COLUMN trace_id TEXT');
        }
        // Additive migration (context_compression Q2): per-session turn counter
        // and the turn of the last compaction, used by the anti-thrashing cooldown.
        const sessCols = this.db.pragma('table_info(sessions)');
        if (!sessCols.some((c) => c.name === 'turn_count')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0');
        }
        if (!sessCols.some((c) => c.name === 'last_compaction_turn')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN last_compaction_turn INTEGER NOT NULL DEFAULT 0');
        }
        if (!sessCols.some((c) => c.name === 'pinned')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
        }
    }
    // ---------------------------------------------------------------------------
    // Session CRUD
    // ---------------------------------------------------------------------------
    async createSession(data) {
        const id = randomUUID();
        const now = new Date().toISOString();
        this.db
            .prepare(`INSERT INTO sessions
         (id, key, platform, model, provider, personality_id, parent_session_id, working_dir,
          title, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          estimated_cost_usd, api_call_count, compaction_count, metadata, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(id, data.key, data.platform, data.model, data.provider, data.personalityId ?? null, data.parentSessionId ?? null, data.workingDir ?? null, data.title ?? null, data.usage.inputTokens, data.usage.outputTokens, data.usage.cacheReadTokens, data.usage.cacheCreationTokens, data.usage.estimatedCostUsd, data.usage.apiCallCount, data.usage.compactionCount, data.metadata ? JSON.stringify(data.metadata) : null, now, now);
        return { ...data, id, createdAt: new Date(now), updatedAt: new Date(now) };
    }
    async getSession(id) {
        const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
        return row ? rowToSession(row) : null;
    }
    async getSessionByKey(key) {
        const row = this.db.prepare('SELECT * FROM sessions WHERE key = ?').get(key);
        return row ? rowToSession(row) : null;
    }
    async updateSession(id, patch) {
        const now = new Date().toISOString();
        const sets = ['updated_at = ?'];
        const values = [now];
        if (patch.title !== undefined) {
            sets.push('title = ?');
            values.push(patch.title);
        }
        if (patch.personalityId !== undefined) {
            sets.push('personality_id = ?');
            values.push(patch.personalityId);
        }
        if (patch.model !== undefined) {
            sets.push('model = ?');
            values.push(patch.model);
        }
        if (patch.metadata !== undefined) {
            sets.push('metadata = ?');
            values.push(JSON.stringify(patch.metadata));
        }
        if (patch.pinned !== undefined) {
            sets.push('pinned = ?');
            values.push(patch.pinned ? 1 : 0);
        }
        values.push(id);
        this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }
    async deleteSession(id) {
        this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    }
    async listSessions(filter) {
        const conditions = [];
        const values = [];
        if (filter?.platform) {
            conditions.push('platform = ?');
            values.push(filter.platform);
        }
        if (filter?.keyPrefix) {
            conditions.push("key LIKE ? ESCAPE '\\'");
            values.push(`${filter.keyPrefix.replace(/[%_\\]/g, '\\$&')}%`);
        }
        if (filter?.personalityId) {
            conditions.push('personality_id = ?');
            values.push(filter.personalityId);
        }
        if (filter?.workingDir) {
            conditions.push('working_dir = ?');
            values.push(filter.workingDir);
        }
        if (filter?.since) {
            conditions.push('created_at >= ?');
            values.push(filter.since.toISOString());
        }
        if (filter?.keyPrefix) {
            conditions.push('key LIKE ?');
            values.push(`${filter.keyPrefix}%`);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const limit = filter?.limit ?? -1;
        const offset = filter?.offset ?? 0;
        const rows = this.db
            .prepare(`SELECT *, rowid AS _row FROM sessions ${where} ORDER BY pinned DESC, updated_at DESC, rowid DESC LIMIT ? OFFSET ?`)
            .all(...values, limit, offset);
        return rows.map(rowToSession);
    }
    // ---------------------------------------------------------------------------
    // Messages
    // ---------------------------------------------------------------------------
    async appendMessage(data) {
        const id = randomUUID();
        const timestamp = new Date().toISOString();
        this.db
            .prepare(`INSERT INTO messages
         (id, session_id, role, content, tool_call_id, tool_name, tool_calls,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          estimated_cost_usd, timestamp)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(id, data.sessionId, data.role, data.content, data.toolCallId ?? null, data.toolName ?? null, data.toolCalls ? JSON.stringify(data.toolCalls) : null, data.usage?.inputTokens ?? null, data.usage?.outputTokens ?? null, data.usage?.cacheReadTokens ?? null, data.usage?.cacheCreationTokens ?? null, data.usage?.estimatedCostUsd ?? null, timestamp);
        return { ...data, id, timestamp: new Date(timestamp) };
    }
    async getMessages(sessionId, options) {
        // Return most-recent `limit` messages in chronological order
        const offset = options?.offset ?? 0;
        const limit = options?.limit;
        // rowid breaks timestamp ties (insertion order). Must be explicit in SELECT to be visible
        // in the outer query.
        const rows = limit !== undefined
            ? this.db
                .prepare(`SELECT * FROM (
                 SELECT *, rowid AS _row FROM messages WHERE session_id = ?
                 ORDER BY timestamp DESC, rowid DESC LIMIT ? OFFSET ?
               ) ORDER BY timestamp ASC, _row ASC`)
                .all(sessionId, limit, offset)
            : this.db
                .prepare(`SELECT *, rowid AS _row FROM messages WHERE session_id = ?
               ORDER BY timestamp ASC, rowid ASC LIMIT -1 OFFSET ?`)
                .all(sessionId, offset);
        return rows.map(rowToMessage);
    }
    async updateUsage(sessionId, delta) {
        const sets = ['updated_at = ?'];
        const values = [new Date().toISOString()];
        const colMap = {
            inputTokens: 'input_tokens',
            outputTokens: 'output_tokens',
            cacheReadTokens: 'cache_read_tokens',
            cacheCreationTokens: 'cache_creation_tokens',
            estimatedCostUsd: 'estimated_cost_usd',
            apiCallCount: 'api_call_count',
            compactionCount: 'compaction_count',
        };
        for (const [key, val] of Object.entries(delta)) {
            const col = colMap[key];
            sets.push(`${col} = ${col} + ?`);
            values.push(val);
        }
        values.push(sessionId);
        this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }
    // ---------------------------------------------------------------------------
    // Full-text search via FTS5
    // ---------------------------------------------------------------------------
    async search(query, options) {
        const limit = options?.limit ?? 20;
        const safeQuery = escapeFtsQuery(query);
        const conditions = ['messages_fts MATCH ?'];
        const values = [safeQuery];
        if (options?.sessionId) {
            conditions.push('m.session_id = ?');
            values.push(options.sessionId);
        }
        if (options?.since) {
            conditions.push('m.timestamp >= ?');
            values.push(options.since.toISOString());
        }
        if (options?.until) {
            conditions.push('m.timestamp <= ?');
            values.push(options.until.toISOString());
        }
        // No migration required: the existing idx_messages_session(session_id, timestamp) index covers the new predicate.
        const where = conditions.join(' AND ');
        const rows = this.db
            .prepare(`SELECT m.id, m.session_id, m.content, m.timestamp,
                bm25(messages_fts) AS score
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         WHERE ${where}
         ORDER BY bm25(messages_fts)
         LIMIT ?`)
            .all(...values, limit);
        return rows.map((r) => ({
            sessionId: r.session_id,
            messageId: r.id,
            snippet: extractSnippet(r.content, query),
            score: -r.score, // bm25 returns negative; flip so higher = better
            timestamp: new Date(r.timestamp),
        }));
    }
    // ---------------------------------------------------------------------------
    // Compression events (context_compression F3)
    // ---------------------------------------------------------------------------
    async recordCompression(event) {
        const id = randomUUID();
        const createdAt = new Date();
        this.db
            .prepare(`INSERT INTO compressions
         (id, session_id, created_at, engine_name, original_count, kept_count,
          summary_text, summary_tokens, pre_total_tokens, post_total_tokens, duration_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
            .run(id, event.sessionId, createdAt.toISOString(), event.engineName, event.originalCount, event.keptCount, event.summaryText ?? null, event.summaryTokens, event.preTotalTokens, event.postTotalTokens, event.durationMs);
        return { ...event, id, createdAt };
    }
    async listCompressions(sessionId) {
        const rows = this.db
            .prepare(`SELECT * FROM compressions WHERE session_id = ?
         ORDER BY created_at ASC, rowid ASC`)
            .all(sessionId);
        return rows.map(rowToCompression);
    }
    // ---------------------------------------------------------------------------
    // Turn bookkeeping (context_compression Q2 — anti-thrashing cooldown)
    // ---------------------------------------------------------------------------
    async recordTurnStart(sessionId) {
        const row = this.db
            .prepare(`UPDATE sessions SET turn_count = turn_count + 1
         WHERE id = ?
         RETURNING turn_count AS turnNumber, last_compaction_turn AS lastCompactionTurn`)
            .get(sessionId);
        return row ?? { turnNumber: 0, lastCompactionTurn: 0 };
    }
    async recordCompactionTurn(sessionId, turnNumber) {
        this.db
            .prepare('UPDATE sessions SET last_compaction_turn = ? WHERE id = ?')
            .run(turnNumber, sessionId);
    }
    // ---------------------------------------------------------------------------
    // Maintenance
    // ---------------------------------------------------------------------------
    // ---------------------------------------------------------------------------
    // FW-4 — title management
    // ---------------------------------------------------------------------------
    async setTitle(sessionId, title) {
        const now = new Date().toISOString();
        this.db
            .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
            .run(title, now, sessionId);
    }
    // ---------------------------------------------------------------------------
    // FW-2 — resume lookup
    // ---------------------------------------------------------------------------
    async findMostRecent(platform) {
        // rowid tie-breaks same-millisecond timestamps (higher rowid = later insert/update)
        const row = platform
            ? this.db
                .prepare('SELECT *, rowid AS _row FROM sessions WHERE platform = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1')
                .get(platform)
            : this.db
                .prepare('SELECT *, rowid AS _row FROM sessions ORDER BY updated_at DESC, rowid DESC LIMIT 1')
                .get();
        return row ? rowToSession(row) : null;
    }
    async findByTitle(query) {
        const lower = query.toLowerCase();
        // 1. Exact match (case-insensitive)
        const exact = this.db
            .prepare('SELECT * FROM sessions WHERE LOWER(title) = ?')
            .all(lower);
        if (exact.length > 0)
            return exact.map(rowToSession);
        // 2. Fragment match (case-insensitive substring)
        const fragment = this.db
            .prepare('SELECT * FROM sessions WHERE LOWER(title) LIKE ?')
            .all(`%${lower}%`);
        return fragment.map(rowToSession);
    }
    async pruneOldSessions(olderThan) {
        const result = this.db
            .prepare('DELETE FROM sessions WHERE updated_at < ?')
            .run(olderThan.toISOString());
        return result.changes;
    }
    async vacuum() {
        this.db.exec('VACUUM');
    }
    /** Close the database connection (useful in tests). */
    close() {
        this.db.close();
    }
}
function rowToSession(r) {
    return {
        id: r.id,
        key: r.key,
        platform: r.platform,
        model: r.model,
        provider: r.provider,
        personalityId: r.personality_id ?? undefined,
        parentSessionId: r.parent_session_id ?? undefined,
        workingDir: r.working_dir ?? undefined,
        title: r.title ?? undefined,
        pinned: !!r.pinned,
        usage: {
            inputTokens: r.input_tokens,
            outputTokens: r.output_tokens,
            cacheReadTokens: r.cache_read_tokens,
            cacheCreationTokens: r.cache_creation_tokens,
            estimatedCostUsd: r.estimated_cost_usd,
            apiCallCount: r.api_call_count,
            compactionCount: r.compaction_count,
        },
        metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
        createdAt: new Date(r.created_at),
        updatedAt: new Date(r.updated_at),
    };
}
function rowToMessage(r) {
    return {
        id: r.id,
        sessionId: r.session_id,
        role: r.role,
        content: r.content,
        toolCallId: r.tool_call_id ?? undefined,
        toolName: r.tool_name ?? undefined,
        toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
        usage: r.input_tokens != null
            ? {
                inputTokens: r.input_tokens,
                outputTokens: r.output_tokens ?? 0,
                cacheReadTokens: r.cache_read_tokens ?? 0,
                cacheCreationTokens: r.cache_creation_tokens ?? 0,
                estimatedCostUsd: r.estimated_cost_usd ?? 0,
            }
            : undefined,
        timestamp: new Date(r.timestamp),
    };
}
function rowToCompression(r) {
    return {
        id: r.id,
        sessionId: r.session_id,
        createdAt: new Date(r.created_at),
        engineName: r.engine_name,
        originalCount: r.original_count,
        keptCount: r.kept_count,
        summaryText: r.summary_text ?? undefined,
        summaryTokens: r.summary_tokens,
        preTotalTokens: r.pre_total_tokens,
        postTotalTokens: r.post_total_tokens,
        durationMs: r.duration_ms,
    };
}
// ---------------------------------------------------------------------------
// FTS helpers
// ---------------------------------------------------------------------------
function escapeFtsQuery(query) {
    // Wrap in quotes to treat as a phrase; escape internal quotes
    return `"${query.replace(/"/g, '""')}"`;
}
function extractSnippet(content, query) {
    const lower = content.toLowerCase();
    const idx = lower.indexOf(query.toLowerCase());
    if (idx < 0)
        return content.slice(0, 200);
    const start = Math.max(0, idx - 50);
    const end = Math.min(content.length, idx + 150);
    return content.slice(start, end);
}
