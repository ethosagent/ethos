import { oc } from '@orpc/contract';
import { z } from 'zod';
import { SessionCardSchema } from '../cards';
import { SessionDecisionSchema } from '../events';
import { SessionSchema, StoredMessageSchema } from '../schemas';

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const SessionListInput = z.object({
  /** Full-text query (FTS5). Empty / omitted returns recent sessions. */
  q: z.string().optional(),
  /** Page size; max 200 to keep payloads bounded. */
  limit: z.number().int().min(1).max(200).optional(),
  /** Opaque rowid cursor from the previous response's `nextCursor`. */
  cursor: z.string().nullable().optional(),
  personalityId: z.string().optional(),
  /** Only sessions whose origin platform is exactly this (`cli`, `web`, `mcp`, …). */
  platform: z.string().optional(),
  /** Only the direct forks of this session (`parentSessionId`) — the branch switcher. */
  parentSessionId: z.string().optional(),
});
const SessionListOutput = z.object({
  items: z.array(SessionSchema),
  nextCursor: z.string().nullable(),
});

const SessionGetInput = z.object({
  id: z.string(),
  /**
   * Default `true`: `messages` and `cards` carry the WHOLE session. `false`
   * skips reading them, and both arrays are then `[]` meaning "not requested",
   * not "none" — page the history with `sessions.messages` instead.
   */
  withMessages: z.boolean().default(true),
});
const SessionGetOutput = z.object({
  session: SessionSchema,
  /** Every message, oldest first. `[]` when `withMessages: false` (not requested). */
  messages: z.array(StoredMessageSchema),
  /** Card envelopes emitted during this session, for replay. Empty when none, or when not requested. */
  cards: z.array(SessionCardSchema),
  /** Settled decision rows, oldest first, for replay (plan decision-provider-personality §15.5). Empty when none, or when not requested. */
  decisions: z.array(SessionDecisionSchema),
});

// Turn-based, cursor-paged history, newest page first. A turn starts at a
// `user` message (`user_steer` does not start one) and is never split across
// pages; rows before the first user message ride with the page that reaches the
// start. A page also stops adding older turns at ~500 KB of message content,
// but always carries at least one whole turn.
const SessionMessagesInput = z.object({
  id: z.string(),
  /** Opaque cursor from a previous response's `nextCursor`. Absent = the newest turns. */
  before: z.string().optional(),
  /** Whole turns per page. */
  turns: z.number().int().min(1).max(100).default(20),
});
const SessionMessagesOutput = z.object({
  /** The page's messages, oldest first. */
  messages: z.array(StoredMessageSchema),
  /** Only the cards whose tool call belongs to a message in this page. */
  cards: z.array(SessionCardSchema),
  /** Only the decision rows this page anchors: their `toolCallId` belongs to a
   *  message in this page, or their `traceId` is a page message's `traceId`. */
  decisions: z.array(SessionDecisionSchema),
  /** Pass as `before` for the next-older page. `null` once the page reaches the start of the session. */
  nextCursor: z.string().nullable(),
});

const SessionForkInput = z.object({
  id: z.string(),
  personalityId: z.string().optional(),
  /** Optimistic-concurrency guard. v1 ignores this. */
  expectedVersion: z.number().int().optional(),
});
const SessionForkOutput = z.object({ session: SessionSchema });

const SessionDeleteInput = z.object({
  id: z.string(),
  /** Optimistic-concurrency guard. v1 ignores this. */
  expectedVersion: z.number().int().optional(),
});
const SessionDeleteOutput = z.object({ ok: z.literal(true) });

const SessionUpdateInput = z.object({
  id: z.string(),
  /** New human-readable title. Pass null to clear the title. */
  title: z.string().max(200).nullable(),
  /** Optimistic-concurrency guard. v1 ignores this. */
  expectedVersion: z.number().int().optional(),
});
const SessionUpdateOutput = z.object({ session: SessionSchema });

const SessionExportInput = z.object({
  id: z.string(),
  format: z.enum(['markdown']),
});
const SessionExportOutput = z.object({
  content: z.string(),
  filename: z.string(),
});

const SessionPinInput = z.object({ id: z.string() });
const SessionPinOutput = z.object({ session: SessionSchema });

// Phase 0 — per-session context anatomy, aggregated from observability.db
// `llm_call` spans (never the sessions.db message rows, so nothing
// double-counts). Null when there is no span data yet.
const ContextAnatomySchema = z.object({
  system: z.number(),
  tools: z.number(),
  messages: z.number(),
  total: z.number(),
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheHitRate: z.number(),
  llmCallCount: z.number(),
});
const SessionContextAnatomyInput = z.object({ id: z.string() });
const SessionContextAnatomyOutput = z.object({ anatomy: ContextAnatomySchema.nullable() });
export type ContextAnatomyWire = z.infer<typeof ContextAnatomySchema>;

/** @stable v1 */
export const sessions = {
  list: oc.input(SessionListInput).output(SessionListOutput),
  get: oc.input(SessionGetInput).output(SessionGetOutput),
  messages: oc.input(SessionMessagesInput).output(SessionMessagesOutput),
  fork: oc.input(SessionForkInput).output(SessionForkOutput),
  delete: oc.input(SessionDeleteInput).output(SessionDeleteOutput),
  update: oc.input(SessionUpdateInput).output(SessionUpdateOutput),
  export: oc.input(SessionExportInput).output(SessionExportOutput),
  pin: oc.input(SessionPinInput).output(SessionPinOutput),
  unpin: oc.input(SessionPinInput).output(SessionPinOutput),
  contextAnatomy: oc.input(SessionContextAnatomyInput).output(SessionContextAnatomyOutput),
  undoTurns: oc
    .input(z.object({ id: z.string(), n: z.number().int().min(1).default(1) }))
    .output(z.object({ removed: z.number() })),
  // Phase 2 — manual `/compact`. Forces a compaction outside a turn and persists
  // a watermark so it survives into later turns. `instructions` is the optional
  // `/compact <focus…>` hint threaded into the summarizer.
  compact: oc.input(z.object({ id: z.string(), instructions: z.string().optional() })).output(
    z.object({
      ok: z.boolean(),
      engineName: z.string(),
      droppedCount: z.number(),
      preTotalTokens: z.number(),
      postTotalTokens: z.number(),
      summariesEnabled: z.boolean(),
    }),
  ),
};

// ---------------------------------------------------------------------------
// Activity — durable history read from observability.db (spans / turn traces /
// events), merged into one newest-first timeline. `personalityId` scopes it to
// one agent; omitting it is the global (Library-altitude) view.
// ---------------------------------------------------------------------------

const ActivityHistoryItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['tool_call', 'llm_call', 'turn', 'event']),
  name: z.string(),
  sessionId: z.string().nullable(),
  personalityId: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  status: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
});
const ActivityHistoryInput = z.object({
  personalityId: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  /**
   * Exclusive cursor from the previous page — BOTH halves, round-tripped
   * together. A bare ms-epoch cursor is not enough: parallel tool calls share a
   * millisecond, so a page boundary inside a tied group would skip the rest of
   * it. `beforeId` breaks the tie against the same `(startedAt, id)` order the
   * server pages by.
   */
  before: z.number().optional(),
  beforeId: z.string().optional(),
});
const ActivityHistoryOutput = z.object({
  items: z.array(ActivityHistoryItemSchema),
  nextBefore: z.number().nullable(),
  nextBeforeId: z.string().nullable(),
});
export type ActivityHistoryItemWire = z.infer<typeof ActivityHistoryItemSchema>;

export const activity = {
  history: oc.input(ActivityHistoryInput).output(ActivityHistoryOutput),
};
