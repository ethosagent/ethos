// Phase 4 — Memory policy decorators.
//
// Decorators that wrap MemoryProvider to apply access policies.  Each
// decorator depends only on the MemoryProvider contract from @ethosagent/types
// and is backend-neutral, so they live in core (not in an extension).
//
// Wiring intent:
//   Personality scope:  EagerPrefetchPolicy(MarkdownProvider)
//   Team scope:         LazyOnDemandPolicy(LastWriteWinsPolicy(MarkdownProvider))

import type {
  ListOpts,
  MemoryContext,
  MemoryEntry,
  MemoryEntryRef,
  MemoryProvider,
  MemorySnapshot,
  MemoryUpdate,
  SearchOpts,
} from '@ethosagent/types';
import { MemoryConflictError } from '@ethosagent/types';

export { MemoryConflictError } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// EagerPrefetchPolicy
// ---------------------------------------------------------------------------

/**
 * Pass-through decorator that makes the wiring intent explicit: this provider
 * uses eager prefetch (all content injected at session start).  The AgentLoop
 * already calls `prefetch()` on every session open; this wrapper delegates all
 * five methods unchanged.  Used for personality memory.
 */
export class EagerPrefetchPolicy implements MemoryProvider {
  constructor(private readonly inner: MemoryProvider) {}

  prefetch(ctx: MemoryContext): Promise<MemorySnapshot | null> {
    return this.inner.prefetch(ctx);
  }

  read(key: string, ctx: MemoryContext): Promise<MemoryEntry | null> {
    return this.inner.read(key, ctx);
  }

  search(query: string, ctx: MemoryContext, opts?: SearchOpts): Promise<MemoryEntry[]> {
    return this.inner.search(query, ctx, opts);
  }

  sync(updates: MemoryUpdate[], ctx: MemoryContext): Promise<void> {
    return this.inner.sync(updates, ctx);
  }

  list(ctx: MemoryContext, opts?: ListOpts): Promise<MemoryEntryRef[]> {
    return this.inner.list(ctx, opts);
  }
}

// ---------------------------------------------------------------------------
// LazyOnDemandPolicy
// ---------------------------------------------------------------------------

/**
 * Suppresses bulk prefetch.  `prefetch()` returns null so the AgentLoop does
 * not inject all content at session start.  The existing
 * `createTeamMemoryIndexInjector` in wiring handles the lightweight topic-index
 * injection via `list()`.  All other methods delegate unchanged.
 *
 * Used for team memory: agents see a topic index and load content on demand via
 * team_memory_read.
 */
export class LazyOnDemandPolicy implements MemoryProvider {
  constructor(private readonly inner: MemoryProvider) {}

  async prefetch(_ctx: MemoryContext): Promise<MemorySnapshot | null> {
    return null;
  }

  read(key: string, ctx: MemoryContext): Promise<MemoryEntry | null> {
    return this.inner.read(key, ctx);
  }

  search(query: string, ctx: MemoryContext, opts?: SearchOpts): Promise<MemoryEntry[]> {
    return this.inner.search(query, ctx, opts);
  }

  sync(updates: MemoryUpdate[], ctx: MemoryContext): Promise<void> {
    return this.inner.sync(updates, ctx);
  }

  list(ctx: MemoryContext, opts?: ListOpts): Promise<MemoryEntryRef[]> {
    return this.inner.list(ctx, opts);
  }
}

// ---------------------------------------------------------------------------
// LastWriteWinsPolicy
// ---------------------------------------------------------------------------

/**
 * Wraps `sync()` with an optimistic-concurrency precondition check.
 *
 * The policy records the `mtime` (from `MemoryEntry.metadata.lastUpdatedAt`)
 * each time `read()` or `search()` returns an entry, keyed by
 * `${scopeId}:${key}`.  When `sync()` is called for a key the policy has a
 * read-timestamp for, it re-reads the current `mtime` from the inner provider
 * and rejects the write with a `MemoryConflictError` if the file has been
 * modified since the caller last saw it.
 *
 * Keys never read (no timestamp recorded) pass through unconditionally —
 * this avoids blocking blind adds on new keys.
 *
 * **Known limitation — not fully atomic:** the mtime check and the subsequent
 * `inner.sync()` are not a single atomic operation.  Two concurrent writers
 * that both pass the mtime check in the same millisecond can both write.  This
 * is an inherent property of the decorator approach over a filesystem backend;
 * a fully atomic compare-and-swap would require support in the storage layer.
 * The policy catches the common case of sequential-but-concurrent agents where
 * writes are spaced by network and tool-call latency.
 *
 * **Instance scope:** one `LastWriteWinsPolicy` instance tracks timestamps for
 * one caller (typically one AgentLoop / session).  Do not share an instance
 * across concurrent callers — the read-timestamp map is not thread-isolated and
 * cross-caller reads would invalidate each other's preconditions.
 *
 * Used for team memory to prevent silent overwrites when two agents write the
 * same file within the same session boundary.
 */
export class LastWriteWinsPolicy implements MemoryProvider {
  /** scopeId:key → mtime at last read (ms). */
  private readonly lastReadAt = new Map<string, number>();

  constructor(private readonly inner: MemoryProvider) {}

  prefetch(ctx: MemoryContext): Promise<MemorySnapshot | null> {
    return this.inner.prefetch(ctx);
  }

  /** Records the entry's mtime so sync() can detect concurrent modifications. */
  async read(key: string, ctx: MemoryContext): Promise<MemoryEntry | null> {
    const entry = await this.inner.read(key, ctx);
    if (entry?.metadata?.lastUpdatedAt !== undefined) {
      this.lastReadAt.set(`${ctx.scopeId}:${key}`, entry.metadata.lastUpdatedAt);
    }
    return entry;
  }

  /**
   * Records mtimes for entries returned by search so that a write based on
   * search results also benefits from conflict detection.
   *
   * Only sets the mtime when no prior timestamp is recorded for the key.
   * Overwriting an existing timestamp from a search result would allow a
   * stale write to pass: caller reads at mtime 1, external writer bumps to
   * mtime 2, caller searches and the result records mtime 2, caller syncs
   * stale content — conflict check passes because currentAt === recordedAt.
   * Preserving the oldest (first-read) mtime ensures that risk does not apply.
   */
  async search(query: string, ctx: MemoryContext, opts?: SearchOpts): Promise<MemoryEntry[]> {
    const results = await this.inner.search(query, ctx, opts);
    for (const entry of results) {
      const mapKey = `${ctx.scopeId}:${entry.key}`;
      if (entry.metadata?.lastUpdatedAt !== undefined && !this.lastReadAt.has(mapKey)) {
        this.lastReadAt.set(mapKey, entry.metadata.lastUpdatedAt);
      }
    }
    return results;
  }

  /**
   * For each key that was previously read, check the current mtime against
   * the recorded read-timestamp.  Rejects the entire call if any key has been
   * modified by another writer since the caller last read it.
   */
  async sync(updates: MemoryUpdate[], ctx: MemoryContext): Promise<void> {
    // Collect distinct keys that have updates (excluding deletes on unseen keys).
    const keysToCheck = new Set<string>();
    for (const u of updates) {
      const readAt = this.lastReadAt.get(`${ctx.scopeId}:${u.key}`);
      if (readAt !== undefined) {
        keysToCheck.add(u.key);
      }
    }

    // Fetch current mtimes for all keys that need a precondition check.
    await Promise.all(
      [...keysToCheck].map(async (key) => {
        const current = await this.inner.read(key, ctx);
        const currentMtime = current?.metadata?.lastUpdatedAt;
        const readAt = this.lastReadAt.get(`${ctx.scopeId}:${key}`);
        if (readAt !== undefined && currentMtime !== undefined && currentMtime > readAt) {
          throw new MemoryConflictError({
            key,
            scopeId: ctx.scopeId,
            recordedAt: readAt,
            currentAt: currentMtime,
          });
        }
      }),
    );

    return this.inner.sync(updates, ctx);
  }

  list(ctx: MemoryContext, opts?: ListOpts): Promise<MemoryEntryRef[]> {
    return this.inner.list(ctx, opts);
  }
}

// ---------------------------------------------------------------------------
// AuthorisationPolicy  (placeholder)
// ---------------------------------------------------------------------------

/**
 * Placeholder for future role-based access control on memory operations.
 * TODO: implement scope × role × operation permission matrix.
 * Not wired — stub only.
 */
export class AuthorisationPolicy implements MemoryProvider {
  constructor(private readonly inner: MemoryProvider) {}

  prefetch(ctx: MemoryContext): Promise<MemorySnapshot | null> {
    return this.inner.prefetch(ctx);
  }

  read(key: string, ctx: MemoryContext): Promise<MemoryEntry | null> {
    return this.inner.read(key, ctx);
  }

  search(query: string, ctx: MemoryContext, opts?: SearchOpts): Promise<MemoryEntry[]> {
    return this.inner.search(query, ctx, opts);
  }

  sync(updates: MemoryUpdate[], ctx: MemoryContext): Promise<void> {
    return this.inner.sync(updates, ctx);
  }

  list(ctx: MemoryContext, opts?: ListOpts): Promise<MemoryEntryRef[]> {
    return this.inner.list(ctx, opts);
  }
}
