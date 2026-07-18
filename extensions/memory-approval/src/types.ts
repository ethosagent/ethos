// Approve-before-store gate (memory-lifecycle L2, §3b) — shared shapes.
//
// The gate never adds a `MemoryProvider` method or a `MemoryUpdate` action: a
// gated write is intercepted and parked in a per-scope pending queue instead of
// flowing through to durable memory. Approve replays it through the
// history-recording write path; reject tombstones its fact-hash so a rejected
// fact is never re-proposed.

import type { HistorySource } from '@ethosagent/memory-history';
import type { MemoryUpdate } from '@ethosagent/types';

/**
 * Which memory writers require approval before a write lands durably.
 * - `off`       — nothing is gated (pure pass-through; the default posture).
 * - `automated` — gate the autonomous writers: `capture` and `dream`.
 * - `all`       — gate every write that flows through the decorator, including
 *   explicit `tool` edits and `consolidation` (the paranoid posture).
 *
 * `writeGlobalEntry` (the web Memory-tab whole-file save) is NEVER gated in any
 * mode: it returns the written entry, and a human clicking Save is explicit.
 */
export type MemoryApprovalMode = 'off' | 'automated' | 'all';

/** One parked candidate write awaiting an approve/reject decision. */
export interface PendingEntry {
  /** Opaque queue id (uuid). */
  id: string;
  /** Memory scope the write targets (`personality:<id>` / `team:<id>` / …). */
  scopeId: string;
  /** The single candidate mutation. Replayed verbatim on approve. */
  update: MemoryUpdate;
  /** Original writer, preserved so approve records honest provenance. */
  source: HistorySource;
  /**
   * Normalized fact-hash for a capture candidate — the tombstone key written on
   * reject so the same fact is never re-proposed. Set only by the capture
   * proposer (which owns the exact hash); absent for freeform decorator writes.
   */
  factHash?: string;
  /** Session the candidate originated in — carried into the approve history entry. */
  sessionId?: string;
  sessionKey?: string;
  /** epoch-ms the candidate was queued; drives TTL expiry. */
  proposedAt: number;
}

/** What a writer submits to the queue. `id`/`proposedAt` are assigned by the store. */
export interface ProposeInput {
  scopeId: string;
  update: MemoryUpdate;
  source: HistorySource;
  factHash?: string;
  sessionId?: string;
  sessionKey?: string;
}

/** A rejected/expired fact-hash, so capture never re-proposes it. */
export interface TombstoneRecord {
  factHash: string;
  reason?: string;
  ts: number;
}

/**
 * Emitted when the queue is at its hard cap and the oldest entry is dropped to
 * make room. Wiring adapts this to the process observability sink; tests spy on
 * it directly. The Curator lesson (§3b): a stuck automated writer must
 * back-pressure with a signal, not accumulate silently.
 */
export interface PendingGateObservability {
  onCapExceeded(detail: { scopeId: string; droppedId: string; cap: number }): void;
}

/**
 * Replay an approved candidate through the history-recording write path. Injected
 * by wiring so the store stays decoupled from `HistoryStore`/`withHistory`; the
 * injected fn records the entry under its ORIGINAL `source` plus `approvedBy`.
 */
export type ApplyFn = (entry: PendingEntry, approvedBy: string) => Promise<void>;
