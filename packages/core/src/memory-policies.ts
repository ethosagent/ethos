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
// MemoryConflictError
// ---------------------------------------------------------------------------

/**
 * Thrown by LastWriteWinsPolicy when a concurrent write is detected.
 * Callers can check `instanceof MemoryConflictError` before retrying.
 */
export class MemoryConflictError extends Error {
  readonly key: string;
  readonly scopeId: string;
  /** mtime of the entry at the time of the conflicting sync() call (ms). */
  readonly entryMtime: number;
  /** mtime recorded when the caller last read the entry (ms). */
  readonly lastReadAt: number;

  constructor(opts: { key: string; scopeId: string; entryMtime: number; lastReadAt: number }) {
    super(
      `Conflict on "${opts.key}" in scope "${opts.scopeId}": ` +
        `entry modified at ${opts.entryMtime} but caller last read at ${opts.lastReadAt}`,
    );
    this.name = 'MemoryConflictError';
    this.key = opts.key;
    this.scopeId = opts.scopeId;
    this.entryMtime = opts.entryMtime;
    this.lastReadAt = opts.lastReadAt;
  }
}

// ---------------------------------------------------------------------------
// LastWriteWinsPolicy
// ---------------------------------------------------------------------------

/**
 * Wraps `sync()` with an optimistic-concurrency precondition check.
 *
 * The policy records the `mtime` (from `MemoryEntry.metadata.lastUpdatedAt`)
 * each time `read()` is called, keyed by `${scopeId}:${key}`.  When `sync()`
 * is called for a key the policy has a read-timestamp for, it fetches the
 * current `mtime` from the inner provider and rejects the write with a
 * `MemoryConflictError` if the file has been modified since the last read.
 *
 * Keys never read (no timestamp recorded) pass through unconditionally —
 * this avoids blocking blind adds on new keys.
 *
 * Used for team memory to prevent silent overwrites when two agents write the
 * same file concurrently.
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

  search(query: string, ctx: MemoryContext, opts?: SearchOpts): Promise<MemoryEntry[]> {
    return this.inner.search(query, ctx, opts);
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
            entryMtime: currentMtime,
            lastReadAt: readAt,
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
