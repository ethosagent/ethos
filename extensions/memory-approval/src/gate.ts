// PendingMemoryGate decorator (memory-lifecycle L2, §3b).
//
// A `MemoryProvider & GlobalMemoryStore` decorator — the same composition seam
// as `HistoryMemoryProvider`. On `sync`, updates from a gated source are parked
// in the pending queue instead of flowing through to the inner provider;
// non-gated sources pass straight through. Every read path
// (prefetch/read/search/list/readGlobalEntry) and `writeGlobalEntry` delegate
// unchanged, so a gated deployment's read behaviour stays byte-identical.

import type { HistorySource } from '@ethosagent/memory-history';
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
import type { PendingMemoryStore } from './store';
import type { MemoryApprovalMode } from './types';

export interface WithPendingGateOptions {
  store: PendingMemoryStore;
  mode: MemoryApprovalMode;
  /** Source baked into this handle (`tool` for the agent write path). Dream
   *  turns are relabelled at runtime from the `dream:` sessionKey prefix. */
  source: HistorySource;
}

/** True when a write from `source` must be parked rather than written durably. */
export function isGated(source: HistorySource, mode: MemoryApprovalMode): boolean {
  if (mode === 'off') return false;
  if (mode === 'automated') return source === 'capture' || source === 'dream';
  return true; // 'all' — every write through the decorator is gated.
}

export class PendingMemoryGate implements MemoryProvider, GlobalMemoryStore {
  private readonly inner: MemoryProvider & GlobalMemoryStore;
  private readonly store: PendingMemoryStore;
  private readonly mode: MemoryApprovalMode;
  private readonly source: HistorySource;

  constructor(inner: MemoryProvider & GlobalMemoryStore, opts: WithPendingGateOptions) {
    this.inner = inner;
    this.store = opts.store;
    this.mode = opts.mode;
    this.source = opts.source;
  }

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
    // Dream turns write through the `tool`-baked handle; relabel from the
    // sessionKey, mirroring HistoryMemoryProvider.
    const effective: HistorySource = ctx.sessionKey?.startsWith('dream:') ? 'dream' : this.source;
    if (!isGated(effective, this.mode)) {
      await this.inner.sync(updates, ctx);
      return;
    }
    // Park each candidate. Freeform decorator writes carry no fact-hash — reject
    // just drops them (only capture candidates, with an exact hash, tombstone).
    for (const update of updates) {
      await this.store.propose({
        scopeId: ctx.scopeId,
        update,
        source: effective,
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
      });
    }
  }

  readGlobalEntry(store: 'memory' | 'user'): Promise<GlobalMemoryEntry> {
    return this.inner.readGlobalEntry(store);
  }

  // `writeGlobalEntry` is an explicit human save that returns the written
  // entry — never gated, in any mode.
  writeGlobalEntry(store: 'memory' | 'user', content: string): Promise<GlobalMemoryEntry> {
    return this.inner.writeGlobalEntry(store, content);
  }
}

/**
 * Compose an approval gate around a memory provider. `mode: 'off'` returns the
 * provider untouched so a default deployment is byte-identical to no gate.
 */
export function withPendingGate(
  inner: MemoryProvider & GlobalMemoryStore,
  opts: WithPendingGateOptions,
): MemoryProvider & GlobalMemoryStore {
  if (opts.mode === 'off') return inner;
  return new PendingMemoryGate(inner, opts);
}
