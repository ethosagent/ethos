// Phase 4 — Memory policy decorators.
//
// Decorators that wrap MemoryProvider to apply access policies.  Each
// decorator depends only on the MemoryProvider contract from @ethosagent/types
// and is backend-neutral, so they live in core (not in an extension).
//
// Wiring intent:
//   Personality scope:  EagerPrefetchPolicy(MarkdownProvider)
//   Team scope:         LazyOnDemandPolicy(LastWriteWinsPolicy(MarkdownProvider))
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
export class EagerPrefetchPolicy {
    inner;
    constructor(inner) {
        this.inner = inner;
    }
    prefetch(ctx) {
        return this.inner.prefetch(ctx);
    }
    read(key, ctx) {
        return this.inner.read(key, ctx);
    }
    search(query, ctx, opts) {
        return this.inner.search(query, ctx, opts);
    }
    sync(updates, ctx) {
        return this.inner.sync(updates, ctx);
    }
    list(ctx, opts) {
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
export class LazyOnDemandPolicy {
    inner;
    constructor(inner) {
        this.inner = inner;
    }
    async prefetch(_ctx) {
        return null;
    }
    read(key, ctx) {
        return this.inner.read(key, ctx);
    }
    search(query, ctx, opts) {
        return this.inner.search(query, ctx, opts);
    }
    sync(updates, ctx) {
        return this.inner.sync(updates, ctx);
    }
    list(ctx, opts) {
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
export class LastWriteWinsPolicy {
    inner;
    /** scopeId:key → mtime at last read (ms). */
    lastReadAt = new Map();
    constructor(inner) {
        this.inner = inner;
    }
    // Snapshot entries from prefetch() are not added to the conflict tracker.
    // Callers that rely on conflict detection must use read() before sync().
    // In current wiring, LazyOnDemandPolicy suppresses prefetch() before it
    // reaches this layer, so this is safe.
    prefetch(ctx) {
        return this.inner.prefetch(ctx);
    }
    /** Records the entry's mtime so sync() can detect concurrent modifications. */
    async read(key, ctx) {
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
    async search(query, ctx, opts) {
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
     *
     * After a successful write, updates `lastReadAt` baselines so that a second
     * `sync()` call on the same key does not spuriously fail.  Keys that were
     * deleted are removed from the tracker so they can be re-added later.
     */
    async sync(updates, ctx) {
        // Collect distinct keys that have updates (excluding deletes on unseen keys).
        const keysToCheck = new Set();
        for (const u of updates) {
            const readAt = this.lastReadAt.get(`${ctx.scopeId}:${u.key}`);
            if (readAt !== undefined) {
                keysToCheck.add(u.key);
            }
        }
        // Fetch current mtimes for all keys that need a precondition check.
        // Collect them so we can update baselines after the write without re-reading.
        const fetchedMtimes = new Map();
        await Promise.all([...keysToCheck].map(async (key) => {
            const current = await this.inner.read(key, ctx);
            const currentMtime = current?.metadata?.lastUpdatedAt;
            fetchedMtimes.set(key, currentMtime);
            const readAt = this.lastReadAt.get(`${ctx.scopeId}:${key}`);
            if (readAt !== undefined && currentMtime !== undefined && currentMtime > readAt) {
                throw new MemoryConflictError({
                    key,
                    scopeId: ctx.scopeId,
                    recordedAt: readAt,
                    currentAt: currentMtime,
                });
            }
        }));
        await this.inner.sync(updates, ctx);
        // Update baselines so that a subsequent sync() on the same keys does not
        // spuriously conflict.  Use the mtime that was "current" at check time as
        // the new baseline (the write will have bumped it, but we record the
        // pre-write value as the minimum safe baseline; the next read() will
        // refresh it properly).  For deletes, remove the key from the tracker so
        // it can be re-added later without a spurious conflict.
        for (const u of updates) {
            const mapKey = `${ctx.scopeId}:${u.key}`;
            if (u.action === 'delete') {
                this.lastReadAt.delete(mapKey);
            }
            else if (this.lastReadAt.has(mapKey)) {
                // Only update keys we were already tracking (blind adds have no entry).
                const baseline = fetchedMtimes.get(u.key) ?? Date.now();
                this.lastReadAt.set(mapKey, baseline);
            }
        }
    }
    list(ctx, opts) {
        return this.inner.list(ctx, opts);
    }
}
// ---------------------------------------------------------------------------
// AuthorisationPolicy  (placeholder)
// ---------------------------------------------------------------------------
/**
 * @internal
 * Placeholder for future role-based access control on memory operations.
 * TODO: implement scope × role × operation permission matrix.
 * Not wired — stub only.
 */
export class AuthorisationPolicy {
    inner;
    constructor(inner) {
        this.inner = inner;
    }
    prefetch(ctx) {
        return this.inner.prefetch(ctx);
    }
    read(key, ctx) {
        return this.inner.read(key, ctx);
    }
    search(query, ctx, opts) {
        return this.inner.search(query, ctx, opts);
    }
    sync(updates, ctx) {
        return this.inner.sync(updates, ctx);
    }
    list(ctx, opts) {
        return this.inner.list(ctx, opts);
    }
}
