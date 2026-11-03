import { z } from 'zod';

// ---------------------------------------------------------------------------
// Outbox — the personality approval queue (plan `trust-before-reach.md` Part 2)
//
// A gated `send_message` does not send: it queues a publication here, and a
// human approves exactly one revision of one text to one destination before the
// gateway dispatcher hands it to the delivery ledger.
//
// These are WIRE shapes for that queue, deliberately named `…View`: the
// authoritative types live in `@ethosagent/outbox` (`OutboxItem`,
// `OutboxRevision`, `ReviewReceipt`), and the two must not share a name in a
// file that imports both. Optional fields cross the wire as `null` rather than
// absent, matching `DeliveryObligationSchema` above.
//
// Epoch milliseconds, not ISO strings — same reason the deliveries namespace
// uses them: these are ledger-adjacent timestamps compared against fixed
// windows (7-day expiry, 24h approval validity), never rendered as calendar
// dates by the server.
// ---------------------------------------------------------------------------

/**
 * The item lifecycle. This enum is the wire half of `OutboxState` in
 * `@ethosagent/outbox`, and the two are pinned to each other by the COMPILER,
 * in both directions, at `apps/web-api/src/services/outbox.service.ts`:
 * `ALL_STATES` feeds `options` into `listByState` (so a value here that the
 * store does not know fails to typecheck), and `toView` assigns the store's
 * `item.state` into this enum (so a state the store gained and this did not
 * fails to typecheck). Adding a state to one without the other does not build.
 */
export const OutboxStateSchema = z.enum([
  'awaiting_review',
  'awaiting_approval',
  'approved',
  'sending',
  'sent',
  'unconfirmed',
  'failed',
  'rejected',
  'expired',
]);

/** The advisory reviewer's receipt. Never blocks and never approves (O-D4). */
export const OutboxReviewReceiptViewSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'unclear', 'unavailable']),
  reasons: z.string(),
  /** The revision the reviewer actually read — a later human edit does not
   *  re-run the review, so the receipt keeps this number. */
  revision: z.number().int().positive(),
  reviewedAt: z.number(),
});
export type OutboxReviewReceiptView = z.infer<typeof OutboxReviewReceiptViewSchema>;

/** One immutable revision of the text. */
export const OutboxRevisionViewSchema = z.object({
  revision: z.number().int().positive(),
  text: z.string(),
  contentHash: z.string(),
  /** `agent` for the proposal, otherwise the id of the human who edited. */
  author: z.string(),
  createdAt: z.number(),
});
export type OutboxRevisionView = z.infer<typeof OutboxRevisionViewSchema>;

export const OutboxItemViewSchema = z.object({
  id: z.string(),
  personalityId: z.string(),
  /** The bot that will send. Fixed at propose; a human may edit only the text. */
  botKey: z.string(),
  platform: z.string(),
  chatId: z.string(),
  /** Null for the root chat — a thread is a distinct conversation. */
  threadId: z.string().nullable(),
  revision: z.number().int().positive(),
  /** What `outbox.approve` must carry back for the approval to bind. */
  contentHash: z.string(),
  /**
   * The CURRENT revision's text, byte-exact and NOT truncated — unlike
   * `deliveries.summary`, where the operator is auditing what is owed. Here the
   * whole point is that a human reads the exact bytes that will be published
   * before approving them, so a preview would defeat the feature.
   */
  text: z.string(),
  state: OutboxStateSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  approverPersonality: z.string().nullable(),
  review: OutboxReviewReceiptViewSchema.nullable(),
  /** Who approved, and which revision they approved. Cleared by an edit, a
   *  revoke and a rejection — the approval belongs to a revision. */
  approvedBy: z.string().nullable(),
  approvedAt: z.number().nullable(),
  approvedRevision: z.number().int().positive().nullable(),
  /** When the gateway dispatcher claimed the row. After this, revoke loses. */
  claimedAt: z.number().nullable(),
  sentAt: z.number().nullable(),
  /** Set on `unconfirmed`: the ledger row that owns every retry from then on. */
  obligationId: z.string().nullable(),
  failureReason: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  /** The lane the proposing turn ran in — the UI's "drafted in" line. */
  originSessionKey: z.string().nullable(),
});
export type OutboxItemView = z.infer<typeof OutboxItemViewSchema>;
