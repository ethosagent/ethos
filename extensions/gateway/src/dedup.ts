import { createHash } from 'node:crypto';

/**
 * Context surfaced on every genuine dedup drop, so callers can wire it into
 * observability. Deliberately excludes the message content — only a hash and
 * a length, never the plaintext (which may contain secrets or PII).
 */
export interface DedupDropInfo {
  sessionId: string;
  /** sha256 hex of the dropped content — safe to log, not reversible. */
  contentHash: string;
  contentLength: number;
}

/**
 * Single dedup path for outbound channel messages. Adapter-specific dedup
 * gets pulled into here so a new adapter doesn't need to invent its own
 * idempotency layer. See plan/phases/30-robustness.md § 30.4.
 *
 * Key shape: `${sessionId}:${sha256(content)}`. Same content within `ttlMs`
 * for the same session is a duplicate. Empty content is never deduped.
 *
 * Single-process assumption: dedup state lives entirely in this in-memory
 * `Map`, so it only suppresses duplicates within ONE gateway process. A
 * multi-instance / horizontally-scaled deployment would see the same content
 * pass independent caches and would need a shared store (e.g. Redis) to dedup
 * across instances. Today's single-instance model does not — do not assume
 * this cache is a cross-process idempotency guarantee.
 *
 * Rollback escape hatch: if `ETHOS_DEDUP_LEGACY=1` is set in the env at
 * cache construction, `shouldSend` always returns true (every send goes
 * through). This restores pre-30.4 behavior in case a regression surfaces
 * in a shipped adapter.
 */
export class MessageDedupCache {
  private readonly entries = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly disabled: boolean;
  private readonly maxEntries: number;
  /** Optional observability hook fired on each genuine duplicate drop. */
  private readonly onDrop: ((info: DedupDropInfo) => void) | undefined;

  constructor(
    opts: { ttlMs?: number; maxEntries?: number; onDrop?: (info: DedupDropInfo) => void } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.maxEntries = opts.maxEntries ?? 4096;
    this.disabled = process.env.ETHOS_DEDUP_LEGACY === '1' || this.ttlMs <= 0;
    this.onDrop = opts.onDrop;
  }

  /**
   * Returns `true` if the message is new (and records it). Returns `false`
   * if the same content was sent on the same session within `ttlMs`.
   */
  shouldSend(sessionId: string, content: string): boolean {
    if (this.disabled) return true;
    if (!content) return true;

    const now = Date.now();
    const hash = createHash('sha256').update(content).digest('hex');
    const key = `${sessionId}:${hash}`;

    // Lazy eviction: only check the key we touched. The size cap handles
    // the global bound; a periodic O(N) sweep would dominate hot paths.
    const expiry = this.entries.get(key);
    if (expiry !== undefined) {
      if (expiry > now) {
        // Genuine duplicate within TTL — suppress the send. Surface the drop
        // so operators can see suppressed sends. Fires ONLY here: not on the
        // disabled / empty-content fast-paths above, and not on the expired
        // branch below (that's a stale-entry refresh, not a dropped send).
        this.onDrop?.({ sessionId, contentHash: hash, contentLength: content.length });
        return false;
      }
      this.entries.delete(key); // expired — drop so re-insert refreshes order
    }

    this.setEntry(key);
    return true;
  }

  /**
   * Insert (or refresh) `key` with a fresh TTL and enforce the size cap by
   * evicting the oldest entry. Shared by `shouldSend` and `record` so the
   * eviction policy — a security-adjacent primitive — lives in one place.
   */
  private setEntry(key: string): void {
    // Refresh insertion order so the size cap evicts truly-oldest entries.
    this.entries.delete(key);
    this.entries.set(key, Date.now() + this.ttlMs);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /**
   * Register `content` as already-sent for `sessionId` WITHOUT going through
   * the check side of `shouldSend`. A later `shouldSend(sessionId, content)`
   * with the same content inside the TTL then returns `false`.
   *
   * This exists for the streaming draft-edit path (W3.1): a streamed reply
   * delivers its FINAL content via `editMessage`, which bypasses `shouldSend`
   * entirely, so a subsequent duplicate `send()` of the same content (e.g. a
   * retry or a notification echo) would double-deliver. The streaming path
   * calls `record()` when the last edit lands so the dedup cache still knows
   * the content was delivered.
   *
   * No-op on the disabled (legacy) path and for empty content, mirroring
   * `shouldSend`. Never fires `onDrop` — recording is not a dropped send.
   */
  record(sessionId: string, content: string): void {
    if (this.disabled) return;
    if (!content) return;
    const hash = createHash('sha256').update(content).digest('hex');
    this.setEntry(`${sessionId}:${hash}`);
  }

  /** Forget every key associated with `sessionId` (called by `/new`). */
  clearSession(sessionId: string): void {
    // Entry keys are `${sessionId}:${sha256}`, so the sessionId is everything
    // before the LAST colon. Match it exactly rather than as a colon-prefix:
    // a root lane `a:b:c` is a colon-prefix of a threaded lane `a:b:c:thread`,
    // and a prefix match would wrongly evict the sibling thread's entries.
    for (const key of this.entries.keys()) {
      if (key.slice(0, key.lastIndexOf(':')) === sessionId) this.entries.delete(key);
    }
  }

  size(): number {
    return this.entries.size;
  }
}
