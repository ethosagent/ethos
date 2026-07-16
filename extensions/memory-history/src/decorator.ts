import type {
  GlobalMemoryEntry,
  GlobalMemoryStore,
  ListOpts,
  MemoryContext,
  MemoryEntry,
  MemoryEntryRef,
  MemoryProvider,
  MemorySnapshot,
  MemoryUpdate,
  SearchOpts,
} from '@ethosagent/types';
import type { HistoryStore } from './history-store';
import type { HistorySource } from './types';

export interface WithHistoryOptions {
  /** Source label baked into every entry this handle records. */
  source: HistorySource;
}

/**
 * A `HistoryMemoryProvider` decorator wrapping the inner provider — the same
 * pattern as `ScopedStorage`. It implements the full
 * `MemoryProvider & GlobalMemoryStore` intersection so wiring swaps it in
 * without narrowing callers.
 *
 * It intercepts the two write paths — `sync()` and `writeGlobalEntry()` —
 * recording one history entry per (key, batch). `prefetch` / `read` / `search`
 * / `list` / `readGlobalEntry` pass through untouched, so read behaviour and
 * tool-visible write behaviour stay byte-identical (M-T10 regression).
 */
export class HistoryMemoryProvider implements MemoryProvider, GlobalMemoryStore {
  constructor(
    private readonly inner: MemoryProvider & GlobalMemoryStore,
    private readonly history: HistoryStore,
    private readonly source: HistorySource,
  ) {}

  prefetch(ctx: MemoryContext): Promise<MemorySnapshot | null> {
    return this.inner.prefetch(ctx);
  }

  read(key: string, ctx: MemoryContext): Promise<MemoryEntry | null> {
    return this.inner.read(key, ctx);
  }

  search(query: string, ctx: MemoryContext, opts?: SearchOpts): Promise<MemoryEntry[]> {
    return this.inner.search(query, ctx, opts);
  }

  list(ctx: MemoryContext, opts?: ListOpts): Promise<MemoryEntryRef[]> {
    return this.inner.list(ctx, opts);
  }

  async sync(updates: MemoryUpdate[], ctx: MemoryContext): Promise<void> {
    if (updates.length === 0) return;

    // Distinct keys touched by this batch, in first-seen order.
    const keys: string[] = [];
    for (const u of updates) if (!keys.includes(u.key)) keys.push(u.key);

    // Snapshot before-state per key via the contract read (no file-path
    // coupling to the concrete backend).
    const before = new Map<string, string>();
    for (const key of keys) before.set(key, (await this.inner.read(key, ctx))?.content ?? '');

    await this.inner.sync(updates, ctx);

    // Dream turns write through the same tool handle; distinguish them by the
    // `dream:` sessionKey prefix rather than a separate handle (§2.1).
    const effectiveSource: HistorySource = ctx.sessionKey?.startsWith('dream:')
      ? 'dream'
      : this.source;

    for (const key of keys) {
      const after = (await this.inner.read(key, ctx))?.content ?? '';
      const actions = updates.filter((u) => u.key === key).map((u) => u.action);
      await this.history.record({
        scopeId: ctx.scopeId,
        key,
        actions,
        source: effectiveSource,
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        before: before.get(key) ?? '',
        after,
      });
    }
  }

  readGlobalEntry(store: 'memory' | 'user'): Promise<GlobalMemoryEntry> {
    return this.inner.readGlobalEntry(store);
  }

  async writeGlobalEntry(store: 'memory' | 'user', content: string): Promise<GlobalMemoryEntry> {
    const before = await this.inner.readGlobalEntry(store);
    const result = await this.inner.writeGlobalEntry(store, content);
    await this.history.record({
      scopeId: 'global',
      key: store === 'memory' ? 'MEMORY.md' : 'USER.md',
      actions: ['replace'],
      source: 'global-entry',
      sessionId: '',
      sessionKey: '',
      before: before.content,
      after: result.content,
    });
    return result;
  }
}

/**
 * Compose a history-recording decorator around a memory provider, baking in
 * the source label at composition time. Wiring hands each writer its own
 * decorated handle — `withHistory(provider, history, { source: 'consolidation' })`.
 */
export function withHistory(
  inner: MemoryProvider & GlobalMemoryStore,
  history: HistoryStore,
  opts: WithHistoryOptions,
): MemoryProvider & GlobalMemoryStore {
  return new HistoryMemoryProvider(inner, history, opts.source);
}
