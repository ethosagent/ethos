// Provenance-history entry shape (§2.1 of the memory-experience plan).
//
// One JSON object per line in `memory-history.jsonl` inside each scope dir.
// The history is the audit log for every memory mutation: which source,
// which session, and the before/after diff. Oversized diffs reference a
// content-addressed blob so the full before-state is always recoverable.

/**
 * Where a memory mutation originated. Baked into the decorated handle at
 * composition time (`withHistory(provider, history, { source })`) — no
 * frozen-contract field is added to carry it.
 *
 * - `tool` — the `memory_write` / `team_memory_write` tools.
 * - `consolidation` — the nightly consolidation pass.
 * - `dream` — an idle dream turn (derived from a `dream:` sessionKey).
 * - `capture` — proactive mid-conversation capture (pillar B, wired in M2).
 * - `web-editor` — the web Memory tab whole-file replace.
 * - `global-entry` — the `GlobalMemoryStore.writeGlobalEntry` path.
 * - `restore` — an archive → active restore (pillar C, wired in M3).
 */
export type HistorySource =
  | 'tool'
  | 'consolidation'
  | 'dream'
  | 'capture'
  | 'web-editor'
  | 'global-entry'
  | 'restore';

export interface HistoryEntry {
  /** epoch-ms of the mutation. */
  ts: number;
  scopeId: string;
  key: string;
  /** The `MemoryUpdate.action`s applied to this key in the batch, in order. */
  actions: string[];
  source: HistorySource;
  sessionId: string;
  sessionKey: string;
  /** `sha256:<hex>` of the pre-mutation content. */
  beforeHash: string;
  /** `sha256:<hex>` of the post-mutation content. */
  afterHash: string;
  /** Unified diff (before → after), capped at ~4KB. Truncated when a blob is set. */
  diff: string;
  /**
   * Candidate importance in [0,1]. Set only by `capture` entries; the
   * nightly pass derives section importance from it at consolidation time.
   */
  hint?: number;
  /**
   * `sha256` (hex, no prefix) of the full pre-mutation content, written as a
   * content-addressed blob under `history-blobs/<blob>.md` when the diff
   * exceeds the cap. Guarantees every byte of the before-state stays
   * recoverable even when the inline diff is truncated.
   */
  blob?: string;
  /**
   * Normalized-fact hashes for `capture` entries (pillar B). The append-only
   * history is the dedup substrate: a later capture skips any fact whose hash
   * already appears here in the recent window, so a restated fact is not
   * re-captured — even after the nightly pass rewords MEMORY.md. Set only by
   * the capture runner; absent on every other source.
   */
  captureHashes?: string[];
  /**
   * Attribution for a write that landed via the approve-before-store gate
   * (memory-lifecycle L2): the identity that approved the parked candidate. Set
   * only on approve-replayed entries; absent on every direct write.
   */
  approvedBy?: string;
  sizeBefore: number;
  sizeAfter: number;
}

export interface HistoryReadFilter {
  key?: string;
  source?: HistorySource;
  /** Only entries with `ts >= sinceMs`. */
  sinceMs?: number;
  /** Most-recent N entries (applied after key/source/since filtering). */
  limit?: number;
}

export interface HistoryReadResult {
  /** Entries in chronological order (oldest first). */
  entries: HistoryEntry[];
  /** Count of malformed/torn JSONL lines the tolerant reader skipped. */
  corruptLines: number;
}
