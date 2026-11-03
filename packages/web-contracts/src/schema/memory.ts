import { z } from 'zod';

// ---------------------------------------------------------------------------
// Memory — v1
//
// The web tab edits the two markdown files MarkdownFileMemoryProvider
// reads (MEMORY.md and USER.md, always scoped per-personality).
// Vector-mode CRUD lands later — the contract is markdown-shaped for now.
// ---------------------------------------------------------------------------

export const MemoryStoreSchema = z.enum(['memory', 'user']);
export type MemoryStoreId = z.infer<typeof MemoryStoreSchema>;

export const MemoryFileSchema = z.object({
  store: MemoryStoreSchema,
  /** Markdown body. Empty string when the entry doesn't exist yet. */
  content: z.string(),
  /** Backend-local address (file path for the markdown backend; null for
   *  remote / DB / encrypted backends without one). Diagnostic display only. */
  path: z.string().nullable(),
  /** ISO-8601 mtime, or null when the entry doesn't exist. */
  modifiedAt: z.string().nullable(),
});
export type MemoryFile = z.infer<typeof MemoryFileSchema>;

// Provenance history (memory-experience pillar D, §5). One wire entry per
// memory mutation, mirroring the `HistoryEntry` shape the M1 HistoryStore
// records — minus the capture dedup hashes, which are an internal concern.
export const MemoryHistorySourceSchema = z.enum([
  'tool',
  'consolidation',
  'dream',
  'capture',
  'web-editor',
  'global-entry',
  'restore',
]);
export type MemoryHistorySource = z.infer<typeof MemoryHistorySourceSchema>;

export const MemoryHistoryEntrySchema = z.object({
  /** epoch-ms of the mutation. */
  ts: z.number(),
  scopeId: z.string(),
  key: z.string(),
  /** The `MemoryUpdate.action`s applied to this key in the batch. */
  actions: z.array(z.string()),
  source: MemoryHistorySourceSchema,
  sessionId: z.string(),
  sessionKey: z.string(),
  beforeHash: z.string(),
  afterHash: z.string(),
  /** Unified diff (before → after), inline-capped; truncated when `blob` is set. */
  diff: z.string(),
  /** Candidate importance in [0,1] — present on `capture` entries only. */
  hint: z.number().optional(),
  /** Content-address of the full before-state blob (§2.1). When set, `diff` is
   *  truncated and the full before-content is fetched via `memory.historyBlob`. */
  blob: z.string().optional(),
  sizeBefore: z.number(),
  sizeAfter: z.number(),
});
export type MemoryHistoryEntry = z.infer<typeof MemoryHistoryEntrySchema>;

// Approve-before-store pending queue (memory-lifecycle L3, §3b). One parked
// candidate write awaiting an approve/reject decision — the wire projection of
// `PendingEntry` from `@ethosagent/memory-approval`. The capture dedup fact-hash
// is carried so the queue can render provenance, but is otherwise a server-side
// tombstone key.
export const MemoryUpdateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), key: z.string(), content: z.string() }),
  z.object({ action: z.literal('replace'), key: z.string(), content: z.string() }),
  z.object({ action: z.literal('remove'), key: z.string(), substringMatch: z.string() }),
  z.object({ action: z.literal('delete'), key: z.string() }),
]);
export type MemoryUpdateWire = z.infer<typeof MemoryUpdateSchema>;

export const PendingMemorySchema = z.object({
  /** Opaque queue id (uuid). */
  id: z.string(),
  /** Memory scope the write targets (`personality:<id>` / `team:<id>` / …). */
  scopeId: z.string(),
  /** The single candidate mutation, replayed verbatim on approve. */
  update: MemoryUpdateSchema,
  /** Original writer, so approve records honest provenance. */
  source: MemoryHistorySourceSchema,
  /** Normalized fact-hash for a capture candidate (tombstone key on reject). */
  factHash: z.string().optional(),
  /** Session the candidate originated in. */
  sessionId: z.string().optional(),
  sessionKey: z.string().optional(),
  /** epoch-ms the candidate was queued. */
  proposedAt: z.number(),
  /** Distinct sessions that extracted this fact (`memoryCapture.evidenceSessions`
   *  on). The queue orders by its length; absent when evidence is off. */
  evidenceSessions: z.array(z.string()).optional(),
  /** epoch-ms of the latest re-extraction merged into this candidate. */
  lastSeenAt: z.number().optional(),
});
export type PendingMemory = z.infer<typeof PendingMemorySchema>;

export const IdentityMapEntrySchema = z.object({
  userId: z.string(),
  displayLabel: z.string(),
  platform: z.string(),
  firstSeenAt: z.string(),
});
export type IdentityMapEntryWire = z.infer<typeof IdentityMapEntrySchema>;

export const MeshRouteResultSchema = z.object({
  ok: z.boolean(),
  /** Agent the mesh selected for the synthetic task, or null when no peer
   *  could handle the requested capability. */
  routedTo: z.string().nullable(),
  /** Optional human-readable explanation (e.g. "no peer offers `code`"). */
  reason: z.string().nullable(),
});
export type MeshRouteResult = z.infer<typeof MeshRouteResultSchema>;
