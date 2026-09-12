import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// The publication binding (plan `trust-before-reach.md`, Part 2 *Binding*)
//
// An approval approves ONE text going to ONE destination from ONE sender. The
// hash is what makes that sentence checkable: it covers every field a human
// reads off the approval card, so anything the human saw that later differs
// produces a different hash and the approval stops matching.
//
// `SQLiteOutboxStore.approve` compares it in a conditional UPDATE, and
// `OutboxService.verifyBinding` recomputes it from the stored revision right
// before delivery. Those two are the enforcement; this module only computes.
// ---------------------------------------------------------------------------

/**
 * Everything the binding covers.
 *
 * Destination (`platform`, `chatId`, `threadId`) and sender (`personalityId`,
 * `botKey`) are fixed when an item is proposed; a human may edit only `text`.
 * To publish somewhere else, the item is rejected and the agent proposes again.
 */
export interface ContentHashInput {
  personalityId: string;
  botKey: string;
  platform: string;
  chatId: string;
  /** The thread the publication belongs to; `undefined`/`null` is the root chat. */
  threadId?: string | null;
  /**
   * Byte-exact. NOT trimmed and NOT normalized anywhere on this path: the
   * approver approved the bytes they were shown, trailing whitespace included,
   * and a normalization step here would let the delivered text differ from the
   * reviewed text without changing the hash.
   */
  text: string;
}

/**
 * Canonical JSON of one binding — keys in sorted order, so the encoding is a
 * function of the values alone and not of the order a caller happened to build
 * the object in.
 *
 * `v: 1` is text only. Attachments are deliberately absent rather than
 * optional: no gated path can carry one today (O-D6), and adding a field that
 * is always absent would let a `v:1` hash silently mean two different things
 * the day one appears. Attachments bump this to `v: 2` over each file's sha256
 * of BYTES — hashing a file reference is not enough, because the file behind it
 * can change after approval.
 */
export function canonicalizeContent(input: ContentHashInput): string {
  // Written in sorted key order. `JSON.stringify` emits string keys in
  // insertion order, so the literal below IS the canonical ordering.
  return JSON.stringify({
    botKey: input.botKey,
    chatId: input.chatId,
    personalityId: input.personalityId,
    platform: input.platform,
    text: input.text,
    threadId: input.threadId ?? null,
    v: 1,
  });
}

/** sha256 hex of {@link canonicalizeContent}. */
export function computeContentHash(input: ContentHashInput): string {
  return createHash('sha256').update(canonicalizeContent(input), 'utf8').digest('hex');
}
