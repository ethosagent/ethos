import { homedir } from 'node:os';
import { join } from 'node:path';
import Database, { migrate } from '@ethosagent/sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type {
  ListOpts,
  MemoryContext,
  MemoryEntry,
  MemoryEntryRef,
  MemoryProvider,
  MemorySnapshot,
  MemoryUpdate,
  SearchOpts,
  Storage,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOP_K = 5;
const EMBED_DIM = 384;

/** Maximum size in bytes for any single memory key's content. */
const MAX_MEMORY_BYTES = 512 * 1024; // 512KB per key

// ---------------------------------------------------------------------------
// Lazy singleton embedding pipeline
// ---------------------------------------------------------------------------

type EmbedPipeline = (
  text: string,
  opts: Record<string, unknown>,
) => Promise<{ data: Float32Array }>;

let _pipeline: EmbedPipeline | null = null;
let _pipelinePromise: Promise<EmbedPipeline> | null = null;

async function getDefaultEmbedder(): Promise<EmbedPipeline> {
  if (_pipeline) return _pipeline;
  if (!_pipelinePromise) {
    _pipelinePromise = (async () => {
      const { pipeline } = await import('@xenova/transformers');
      // biome-ignore lint/suspicious/noExplicitAny: @xenova/transformers pipeline return type is not exported
      _pipeline = (await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')) as any;
      return _pipeline as EmbedPipeline;
    })();
  }
  return _pipelinePromise;
}

// ---------------------------------------------------------------------------
// Cosine similarity (pure float arithmetic)
// ---------------------------------------------------------------------------

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VectorMemoryConfig {
  /** Directory containing memory.db. Defaults to ~/.ethos */
  dir?: string;
  /** Number of top results returned by search. Defaults to 5 */
  topK?: number;
  /**
   * Custom embedding function — used in tests to avoid downloading the model.
   * Must return a normalized Float32Array of length 384.
   */
  embedFn?: (text: string) => Promise<Float32Array>;
  /**
   * Storage backend for the markdown side (migrateFromMarkdown, exportAll
   * output). The SQLite side stays raw — @ethosagent/sqlite opens memory.db
   * directly per the storage-abstraction plan's SQLite carve-out.
   */
  storage?: Storage;
}

interface EntryRow {
  scope_id: string;
  key: string;
  content: string;
  embedding: Buffer;
  created_at: string;
  updated_at: string;
}

export interface EntryRecord {
  scopeId: string;
  key: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

// v1 baseline schema — the current table shape, unchanged. Passed to migrate()
// as the idempotent `CREATE ... IF NOT EXISTS` baseline.
const MEMORY_SCHEMA = `
      CREATE TABLE IF NOT EXISTS memory_entries (
        scope_id    TEXT NOT NULL,
        key         TEXT NOT NULL,
        content     TEXT NOT NULL,
        embedding   BLOB NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (scope_id, key)
      ) STRICT;
    `;

// ---------------------------------------------------------------------------
// VectorMemoryProvider
// ---------------------------------------------------------------------------

export class VectorMemoryProvider implements MemoryProvider {
  private readonly db: Database.Database;
  private readonly dir: string;
  private readonly topK: number;
  private readonly embedFn: ((text: string) => Promise<Float32Array>) | undefined;
  private readonly storage: Storage;

  // Per-key mutex to prevent concurrent read-modify-write races in sync().
  // Two concurrent sync() calls for the same scope+key could both read the same
  // content, each append their own addition, then the second upsert overwrites
  // the first's append. The promise-chain mutex serializes per-key operations.
  private locks = new Map<string, Promise<void>>();

  private async withLock(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let resolve: (() => void) | undefined;
    const next = new Promise<void>((r) => {
      resolve = r;
    });
    this.locks.set(key, next);
    await prev;
    try {
      await fn();
    } finally {
      if (resolve) resolve();
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }

  constructor(config: VectorMemoryConfig = {}) {
    this.dir = config.dir ?? join(homedir(), '.ethos');
    this.topK = config.topK ?? TOP_K;
    this.embedFn = config.embedFn;
    this.storage = config.storage ?? new FsStorage();
    this.db = new Database(join(this.dir, 'memory.db'));
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    // Existing production DBs are at user_version=0: migrate() runs the baseline
    // (`IF NOT EXISTS`, a no-op on existing tables) then stamps 0→1. No data
    // touched. The legacy-chunk migration below still runs after, exactly as before.
    migrate(this.db, {
      name: 'memory-vector',
      targetVersion: 1,
      baseline: MEMORY_SCHEMA,
      migrations: {},
    });
    this.migrateLegacyChunks();
  }

  /**
   * Migrate rows from the legacy `memory_chunks` schema (one row per
   * embedded chunk, keyed by an auto-increment `id` and grouped by
   * `store` ∈ {'memory', 'user'}) into the new `memory_entries`
   * schema (one row per key, scoped by `scope_id`).
   *
   * Strategy:
   *  - Each legacy row becomes a `memory_entries` row in scope `global`
   *    with key `legacy-<store>-<id>` (deterministic so the migration
   *    is idempotent and safe to re-run if interrupted).
   *  - The chunk's existing embedding is preserved — re-embedding 1000s
   *    of chunks on every cold start would be a latency cliff.
   *  - The legacy table is dropped only after every row migrates.
   *
   * Skip when the table doesn't exist (fresh install) or has no rows.
   */
  private migrateLegacyChunks(): void {
    const tableExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_chunks'")
      .get();
    if (!tableExists) return;

    const rows = this.db
      .prepare(
        'SELECT id, store, content, embedding, created_at FROM memory_chunks ORDER BY id ASC',
      )
      .all() as Array<{
      id: number;
      store: string;
      content: string;
      embedding: Buffer;
      created_at: string;
    }>;
    if (rows.length === 0) {
      this.db.exec('DROP TABLE memory_chunks');
      return;
    }

    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO memory_entries
       (scope_id, key, content, embedding, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const key = `legacy-${row.store}-${row.id}`;
        insert.run('global', key, row.content, row.embedding, row.created_at, row.created_at);
      }
      this.db.exec('DROP TABLE memory_chunks');
    });
    tx();
  }

  // ---------------------------------------------------------------------------
  // MemoryProvider interface
  // ---------------------------------------------------------------------------

  async prefetch(_ctx: MemoryContext): Promise<MemorySnapshot | null> {
    // Vector stores are not bulk-read at prefetch time — callers use
    // `search` with the live query instead. Returning null lets AgentLoop
    // skip the memory injection step cleanly.
    return null;
  }

  async read(key: string, ctx: MemoryContext): Promise<MemoryEntry | null> {
    const row = this.db
      .prepare(
        'SELECT scope_id, key, content, created_at, updated_at FROM memory_entries WHERE scope_id = ? AND key = ?',
      )
      .get(ctx.scopeId, key) as Omit<EntryRow, 'embedding'> | undefined;
    if (!row) return null;
    return {
      key: row.key,
      content: row.content,
      metadata: { lastUpdatedAt: Date.parse(row.updated_at) },
    };
  }

  async search(query: string, ctx: MemoryContext, opts?: SearchOpts): Promise<MemoryEntry[]> {
    const limit = opts?.limit ?? this.topK;
    const mode = opts?.mode ?? 'semantic';
    const trimmed = query.trim();
    if (!trimmed) return [];

    if (mode === 'keyword') return this.keywordSearch(trimmed, ctx, limit);
    if (mode === 'hybrid') return this.hybridSearch(trimmed, ctx, limit);
    return this.semanticSearch(trimmed, ctx, limit);
  }

  async sync(updates: MemoryUpdate[], ctx: MemoryContext): Promise<void> {
    if (updates.length === 0) return;
    for (const update of updates) {
      const lockKey = `${ctx.scopeId}:${update.key}`;
      await this.withLock(lockKey, async () => {
        switch (update.action) {
          case 'add': {
            // Read existing content, append new, then upsert
            const existing = this.db
              .prepare('SELECT content FROM memory_entries WHERE scope_id = ? AND key = ?')
              .get(ctx.scopeId, update.key) as { content: string } | undefined;
            let combined = existing ? `${existing.content}\n${update.content}` : update.content;
            if (combined.length > MAX_MEMORY_BYTES) {
              const trimmed = combined.slice(combined.length - MAX_MEMORY_BYTES);
              const firstNewline = trimmed.indexOf('\n');
              combined = firstNewline > 0 ? trimmed.slice(firstNewline + 1) : trimmed;
            }
            await this.upsert(ctx.scopeId, update.key, combined);
            break;
          }
          case 'replace': {
            if (!update.content.trim()) {
              this.db
                .prepare('DELETE FROM memory_entries WHERE scope_id = ? AND key = ?')
                .run(ctx.scopeId, update.key);
            } else {
              await this.upsert(ctx.scopeId, update.key, update.content);
            }
            break;
          }
          case 'remove': {
            const match = update.substringMatch;
            if (!match) break;
            const existing = this.db
              .prepare('SELECT content FROM memory_entries WHERE scope_id = ? AND key = ?')
              .get(ctx.scopeId, update.key) as { content: string } | undefined;
            if (!existing) break;
            const filtered = existing.content
              .split('\n')
              .filter((line) => !line.includes(match))
              .join('\n');
            if (!filtered.trim()) {
              this.db
                .prepare('DELETE FROM memory_entries WHERE scope_id = ? AND key = ?')
                .run(ctx.scopeId, update.key);
            } else {
              await this.upsert(ctx.scopeId, update.key, filtered);
            }
            break;
          }
          case 'delete': {
            this.db
              .prepare('DELETE FROM memory_entries WHERE scope_id = ? AND key = ?')
              .run(ctx.scopeId, update.key);
            break;
          }
        }
      });
    }
  }

  async list(ctx: MemoryContext, opts?: ListOpts): Promise<MemoryEntryRef[]> {
    const limit = opts?.limit;
    const sql =
      'SELECT key, content, updated_at FROM memory_entries WHERE scope_id = ? ORDER BY created_at ASC, key ASC' +
      (limit !== undefined ? ' LIMIT ?' : '');
    const stmt = this.db.prepare(sql);
    const rows = (
      limit !== undefined ? stmt.all(ctx.scopeId, limit) : stmt.all(ctx.scopeId)
    ) as Array<Pick<EntryRow, 'key' | 'content' | 'updated_at'>>;
    return rows.map((row) => {
      const ref: MemoryEntryRef = { key: row.key };
      ref.metadata = { lastUpdatedAt: Date.parse(row.updated_at) };
      if (opts?.withSummaries) {
        const para = firstParagraph(row.content);
        if (para) ref.summary = para;
      }
      return ref;
    });
  }

  // ---------------------------------------------------------------------------
  // Manual memory management (called by CLI)
  // ---------------------------------------------------------------------------

  /**
   * Insert a free-form text entry with an auto-generated key. Used by the
   * `ethos memory add` CLI subcommand where the caller doesn't have a
   * key namespace of their own.
   */
  async add(content: string, scopeId = 'cli'): Promise<number> {
    const key = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await this.upsert(scopeId, key, content);
    return 1;
  }

  showRecent(limit = 20): EntryRecord[] {
    const rows = this.db
      .prepare(
        'SELECT scope_id, key, content, created_at, updated_at FROM memory_entries ORDER BY created_at DESC, rowid DESC LIMIT ?',
      )
      .all(limit) as EntryRow[];
    return rows.map((r) => ({
      scopeId: r.scope_id,
      key: r.key,
      content: r.content,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    }));
  }

  async exportAll(outputPath: string): Promise<number> {
    const rows = this.db
      .prepare(
        'SELECT scope_id, key, content, created_at FROM memory_entries ORDER BY created_at ASC, key ASC',
      )
      .all() as EntryRow[];

    if (rows.length === 0) return 0;

    const lines: string[] = [`# Memory Export — ${new Date().toISOString()}`, ''];
    for (const row of rows) {
      lines.push(`## [${row.scope_id}] ${row.key} (${row.created_at.slice(0, 16)})`);
      lines.push('');
      lines.push(row.content);
      lines.push('');
    }

    await this.storage.write(outputPath, lines.join('\n'));
    return rows.length;
  }

  clear(): void {
    this.db.prepare('DELETE FROM memory_entries').run();
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get() as { n: number }).n;
  }

  // ---------------------------------------------------------------------------
  // Migration from MEMORY.md / USER.md
  // ---------------------------------------------------------------------------

  async migrateFromMarkdown(): Promise<{
    migrated: boolean;
    memoryChunks: number;
    userChunks: number;
  }> {
    if (this.count() > 0) return { migrated: false, memoryChunks: 0, userChunks: 0 };

    let memoryChunks = 0;
    let userChunks = 0;
    let didMigrate = false;

    const memPath = join(this.dir, 'MEMORY.md');
    const userPath = join(this.dir, 'USER.md');

    const memContent = await this.storage.read(memPath);
    if (memContent?.trim()) {
      await this.upsert('global', 'MEMORY.md', memContent);
      memoryChunks = 1;
      await this.storage.rename(memPath, `${memPath}.bak`);
      didMigrate = true;
    }

    const userContent = await this.storage.read(userPath);
    if (userContent?.trim()) {
      await this.upsert('global', 'USER.md', userContent);
      userChunks = 1;
      await this.storage.rename(userPath, `${userPath}.bak`);
      didMigrate = true;
    }

    return { migrated: didMigrate, memoryChunks, userChunks };
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async embed(text: string): Promise<Float32Array> {
    if (this.embedFn) return this.embedFn(text);
    const embedder = await getDefaultEmbedder();
    const result = await embedder(text, { pooling: 'mean', normalize: true });
    // result.data may be a view into a larger ArrayBuffer — copy to own buffer
    return new Float32Array(result.data);
  }

  private async upsert(scopeId: string, key: string, content: string): Promise<void> {
    const emb = await this.embed(content);
    const blob = Buffer.from(new Uint8Array(emb.buffer, emb.byteOffset, emb.byteLength));
    const now = new Date().toISOString();
    const existing = this.db
      .prepare('SELECT created_at FROM memory_entries WHERE scope_id = ? AND key = ?')
      .get(scopeId, key) as { created_at: string } | undefined;
    const createdAt = existing?.created_at ?? now;
    this.db
      .prepare(
        `INSERT INTO memory_entries (scope_id, key, content, embedding, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_id, key) DO UPDATE SET
           content = excluded.content,
           embedding = excluded.embedding,
           updated_at = excluded.updated_at`,
      )
      .run(scopeId, key, content, blob, createdAt, now);
  }

  private async semanticSearch(
    query: string,
    ctx: MemoryContext,
    limit: number,
  ): Promise<MemoryEntry[]> {
    const queryEmb = await this.embed(query);
    const rows = this.db
      .prepare('SELECT key, content, embedding, updated_at FROM memory_entries WHERE scope_id = ?')
      .all(ctx.scopeId) as Array<Pick<EntryRow, 'key' | 'content' | 'embedding' | 'updated_at'>>;
    const scored = rows.map((row) => {
      const raw = new Uint8Array(row.embedding);
      const rowEmb = new Float32Array(raw.buffer, raw.byteOffset, EMBED_DIM);
      return { row, score: cosine(queryEmb, rowEmb) };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => ({
      key: s.row.key,
      content: s.row.content,
      metadata: { lastUpdatedAt: Date.parse(s.row.updated_at) },
    }));
  }

  private keywordSearch(query: string, ctx: MemoryContext, limit: number): MemoryEntry[] {
    const needle = query.toLowerCase();
    const rows = this.db
      .prepare('SELECT key, content, updated_at FROM memory_entries WHERE scope_id = ?')
      .all(ctx.scopeId) as Array<Pick<EntryRow, 'key' | 'content' | 'updated_at'>>;
    const matches: MemoryEntry[] = [];
    for (const row of rows) {
      if (matches.length >= limit) break;
      if (row.content.toLowerCase().includes(needle)) {
        matches.push({
          key: row.key,
          content: row.content,
          metadata: { lastUpdatedAt: Date.parse(row.updated_at) },
        });
      }
    }
    return matches;
  }

  private async hybridSearch(
    query: string,
    ctx: MemoryContext,
    limit: number,
  ): Promise<MemoryEntry[]> {
    // Union the two result sets, prefer semantic ordering, dedup by key.
    const sem = await this.semanticSearch(query, ctx, limit);
    const kw = this.keywordSearch(query, ctx, limit);
    const merged = new Map<string, MemoryEntry>();
    for (const r of sem) merged.set(r.key, r);
    for (const r of kw) if (!merged.has(r.key)) merged.set(r.key, r);
    return [...merged.values()].slice(0, limit);
  }
}

function firstParagraph(text: string): string | undefined {
  const para = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0);
  return para && para.length > 0 ? para : undefined;
}
