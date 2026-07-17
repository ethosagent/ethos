import { EthosError, type MemoryContext, type MemoryProvider } from '@ethosagent/types';
import type {
  MemoryFile,
  MemoryHistoryEntry,
  MemoryHistorySource,
  MemoryStoreId,
} from '@ethosagent/web-contracts';
import { type HistoryStore, type IdentityMap, restoreArchivedSlug } from '@ethosagent/wiring';

export interface MemoryServiceOptions {
  memory: MemoryProvider;
  identityMap?: IdentityMap;
  /** Provenance-history reader (M1). Absent in tests / ACP-only deployments —
   *  the Timeline procedures then return empty results. */
  history?: HistoryStore;
  /** A `restore`-labelled memory handle. Absent → restore is unavailable. */
  restoreMemory?: Pick<MemoryProvider, 'read' | 'sync'>;
}

interface HistoryQuery {
  key?: string;
  source?: MemoryHistorySource;
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
  cursor?: string | null;
}

export class MemoryService {
  constructor(private readonly opts: MemoryServiceOptions) {}

  async list(
    personalityId: string,
    listOpts?: { userId?: string },
  ): Promise<{ items: MemoryFile[]; nextCursor: string | null }> {
    const [memoryFile, userFile] = await Promise.all([
      this.readEntry('memory', personalityId, listOpts),
      this.readEntry('user', personalityId, listOpts),
    ]);
    return { items: [memoryFile, userFile], nextCursor: null };
  }

  async get(
    store: MemoryStoreId,
    personalityId: string,
    getOpts?: { userId?: string },
  ): Promise<{ file: MemoryFile }> {
    return { file: await this.readEntry(store, personalityId, getOpts) };
  }

  async write(
    store: MemoryStoreId,
    content: string,
    personalityId: string,
    writeOpts?: { userId?: string },
  ): Promise<{ file: MemoryFile }> {
    const key = store === 'memory' ? 'MEMORY.md' : 'USER.md';
    const ctx = this.buildCtx(this.scopeIdFor(store, personalityId, writeOpts?.userId));
    await this.opts.memory.sync([{ action: 'replace', key, content }], ctx);
    // Re-read to return the persisted state.
    const entry = await this.opts.memory.read(key, ctx);
    const modifiedAt = entry?.metadata?.lastUpdatedAt
      ? new Date(entry.metadata.lastUpdatedAt).toISOString()
      : null;
    return {
      file: {
        store,
        content: entry?.content ?? content,
        path: null,
        modifiedAt,
      },
    };
  }

  async listUsers(): Promise<{
    users: Array<{
      userId: string;
      displayLabel: string;
      platform: string;
      firstSeenAt: string;
    }>;
  }> {
    const entries = (await this.opts.identityMap?.listUsers()) ?? [];
    return {
      users: entries.map((e) => ({
        userId: e.userId,
        displayLabel: e.displayLabel,
        platform: e.platform,
        firstSeenAt: e.firstSeenAt,
      })),
    };
  }

  /**
   * Timeline read (§5). Returns the personality scope's history newest-first,
   * paginated by an opaque offset cursor. Filtering (key / source / date range)
   * runs server-side before pagination so `nextCursor` stays accurate. Returns
   * empty when no history reader is wired.
   */
  async history(
    personalityId: string,
    query: HistoryQuery,
  ): Promise<{
    entries: MemoryHistoryEntry[];
    nextCursor: string | null;
    corruptLines: number;
  }> {
    const history = this.opts.history;
    if (!history) return { entries: [], nextCursor: null, corruptLines: 0 };

    const scopeId = `personality:${personalityId}`;
    const { entries, corruptLines } = await history.read(scopeId, {
      ...(query.key ? { key: query.key } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.sinceMs !== undefined ? { sinceMs: query.sinceMs } : {}),
    });

    // The store returns chronological (oldest first); the Timeline reads
    // newest-first. `untilMs` is applied here since the store filter only
    // supports a lower bound.
    const until = query.untilMs;
    const ordered = entries
      .slice()
      .reverse()
      .filter((e) => (until === undefined ? true : e.ts <= until));

    const limit = query.limit ?? 50;
    const offset = parseCursor(query.cursor);
    const page = ordered.slice(offset, offset + limit);
    const next = offset + limit;
    const nextCursor = next < ordered.length ? String(next) : null;

    return { entries: page.map(toWireEntry), nextCursor, corruptLines };
  }

  /** Fetch one entry's full before-state blob (§2.1) for the diff expander. */
  async historyBlob(personalityId: string, blob: string): Promise<{ content: string | null }> {
    const history = this.opts.history;
    if (!history) return { content: null };
    return { content: await history.readBlob(`personality:${personalityId}`, blob) };
  }

  /**
   * Restore an archived section by slug (§4.2). Reuses the same
   * `restoreArchivedSlug` path the CLI `ethos memory restore` calls, through a
   * `restore`-labelled handle so the move records itself in the history.
   */
  async restore(personalityId: string, slug: string): Promise<{ ok: true; restoredTo: string }> {
    const mem = this.opts.restoreMemory;
    if (!mem) {
      throw new EthosError({
        code: 'NOT_CONFIGURED',
        cause: 'No restore-capable memory handle is wired.',
        action: 'Restore is available when the server runs with a data directory.',
      });
    }
    const ctx = this.buildCtx(`personality:${personalityId}`);
    const result = await restoreArchivedSlug(mem, ctx, slug);
    if (!result.ok) {
      throw new EthosError({
        code: 'NOT_FOUND',
        cause: result.error,
        action:
          result.availableSlugs.length > 0
            ? `Archived slugs: ${result.availableSlugs.join(', ')}`
            : 'The archive has no restorable sections.',
      });
    }
    return { ok: true, restoredTo: result.restoredTo };
  }

  private async readEntry(
    store: MemoryStoreId,
    personalityId: string,
    readOpts?: { userId?: string },
  ): Promise<MemoryFile> {
    const key = store === 'memory' ? 'MEMORY.md' : 'USER.md';
    const ctx = this.buildCtx(this.scopeIdFor(store, personalityId, readOpts?.userId));
    const entry = await this.opts.memory.read(key, ctx);
    const modifiedAt = entry?.metadata?.lastUpdatedAt
      ? new Date(entry.metadata.lastUpdatedAt).toISOString()
      : null;
    return {
      store,
      content: entry?.content ?? '',
      path: null,
      modifiedAt,
    };
  }

  private scopeIdFor(store: MemoryStoreId, personalityId: string, userId?: string): string {
    if (store === 'user' && userId) return `user:${userId}`;
    return `personality:${personalityId}`;
  }

  private buildCtx(scopeId: string): MemoryContext {
    return { scopeId, sessionId: '', sessionKey: '', platform: 'web', workingDir: '' };
  }
}

/** Parse an opaque offset cursor; a missing / malformed cursor is offset 0. */
function parseCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Project a stored history entry onto the wire schema — the capture dedup
 *  hashes stay server-side; everything the Timeline renders is carried. */
function toWireEntry(e: {
  ts: number;
  scopeId: string;
  key: string;
  actions: string[];
  source: MemoryHistorySource;
  sessionId: string;
  sessionKey: string;
  beforeHash: string;
  afterHash: string;
  diff: string;
  hint?: number;
  blob?: string;
  sizeBefore: number;
  sizeAfter: number;
}): MemoryHistoryEntry {
  return {
    ts: e.ts,
    scopeId: e.scopeId,
    key: e.key,
    actions: e.actions,
    source: e.source,
    sessionId: e.sessionId,
    sessionKey: e.sessionKey,
    beforeHash: e.beforeHash,
    afterHash: e.afterHash,
    diff: e.diff,
    ...(e.hint !== undefined ? { hint: e.hint } : {}),
    ...(e.blob !== undefined ? { blob: e.blob } : {}),
    sizeBefore: e.sizeBefore,
    sizeAfter: e.sizeAfter,
  };
}
