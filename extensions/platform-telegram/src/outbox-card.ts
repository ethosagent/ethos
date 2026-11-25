// Outbox approval card shapes and renderers, moved out of `index.ts` (size refactor; no behaviour change).

// ---------------------------------------------------------------------------
// Outbox approval cards (Part 2, O-T8)
//
// A publication a gated personality wants to send is DM'd to the operator as a
// card carrying the full text and two buttons. The adapter renders and routes;
// every policy decision — who is allowed to tap, whether the tapped revision is
// still current, what happens next — belongs to the outbox wiring
// (`apps/ethos/src/lib/outbox-wiring.ts`), which holds the store. Same division
// as `postApprovalCard` / `approvalDecisionHandler`.
// ---------------------------------------------------------------------------

/** Where a publication is headed. Rendered as `name (platform:chatId)`. */
export interface OutboxCardDestination {
  /** Human-readable chat title, when the wiring knows one. */
  name?: string;
  platform: string;
  chatId: string;
}

/** The advisory reviewer's verdict, when a review ran. Rendered verbatim — the
 *  adapter does not interpret a verdict, it shows the one it was handed. */
export interface OutboxCardReview {
  /** The approver personality's id, e.g. `brand-editor`. */
  reviewer: string;
  /** e.g. `PASS` / `FAIL` / `UNCLEAR` / `UNAVAILABLE`. */
  verdict: string;
  reasons?: string;
}

/**
 * Everything a card SHOWS: who wants to publish what, where, as whom.
 *
 * Split out from {@link OutboxCardInput} because a settled card renders it
 * too — a tap must not turn the DM into a bare "Approved", leaving no record
 * of the text that went out. The adapter deliberately remembers nothing about
 * a card it posted (the wiring owns that side map), so `updateOutboxCard` is
 * handed the body back rather than looking it up.
 */
export interface OutboxCardBody {
  revision: number;
  /** The personality that wants to publish, e.g. `cmo`. */
  personalityId: string;
  destination: OutboxCardDestination;
  /** The sending bot as the operator recognises it, e.g. `@EthosMarketingBot`. */
  sender: string;
  /** The publication, byte-exact. Never truncated — see `postOutboxCard`. */
  text: string;
  review?: OutboxCardReview;
}

export interface OutboxCardInput extends OutboxCardBody {
  /** The operator's DM chat. */
  chatId: string;
  threadId?: string;
  itemId: string;
}

/** What a posted card was: the full publication, or the notice that it was too
 *  long to show here. A notice cannot be tapped, so the wiring should not wait
 *  on one. */
export type OutboxCardKind = 'card' | 'notice';

/** The states a posted card can be edited into once it is no longer awaiting a
 *  decision. */
export type OutboxCardStatus =
  | { kind: 'approved'; by: string }
  | { kind: 'sent'; at: string }
  | { kind: 'rejected'; by: string; reason?: string }
  | { kind: 'superseded'; revision: number }
  | { kind: 'expired' }
  /** The send did not happen. `reason` is the item's own failure reason,
   *  rendered verbatim so the DM and the web pane cannot disagree about why. */
  | { kind: 'failed'; reason?: string }
  /** Handed to the delivery ledger, which got no confirmation back. Neither
   *  "sent" nor "not sent" is true yet, and the card must claim neither. */
  | { kind: 'unconfirmed' };

/** An operator tap on an outbox card, surfaced to the outbox wiring. */
export interface OutboxDecisionEvent {
  itemId: string;
  /** The revision the tapped card was posted for. The wiring compares it to
   *  the item's current revision and answers "superseded" when it is stale. */
  revision: number;
  decision: 'approve' | 'reject';
  /** The tapping Telegram user. The wiring compares it to
   *  `channel_filter.telegram.ownerUserId` — the adapter enforces nothing. */
  userId: string | undefined;
  username: string | undefined;
  /** The chat and message of the card that was tapped, so the wiring can edit
   *  it in place. */
  chatId: string;
  messageId: string;
  /** Dismiss the tapping client's spinner, optionally with a toast. If the
   *  handler does not call this, the adapter answers for it. */
  answer: (text?: string) => Promise<void>;
}

/** Parse `obx:a:<id>:<rev>` / `obx:r:<id>:<rev>`. Returns null for anything
 *  else; a malformed payload is answered and dropped, never thrown. Item ids
 *  are `obx_<hex>` and carry no colon, so a fixed 4-field split is exact. */
export function parseOutboxCallback(
  data: string,
): { itemId: string; revision: number; decision: 'approve' | 'reject' } | null {
  const parts = data.split(':');
  if (parts.length !== 4) return null;
  const [, verb, itemId, rawRevision] = parts;
  if (verb !== 'a' && verb !== 'r') return null;
  if (!itemId || !rawRevision) return null;
  if (!/^\d+$/.test(rawRevision)) return null;
  const revision = Number(rawRevision);
  if (!Number.isSafeInteger(revision) || revision < 1) return null;
  return { itemId, revision, decision: verb === 'a' ? 'approve' : 'reject' };
}

function outboxHeader(input: OutboxCardBody): string {
  const { name, platform, chatId } = input.destination;
  const dest = name ? `${name} (${platform}:${chatId})` : `${platform}:${chatId}`;
  return `${input.personalityId} wants to post to ${dest} as ${input.sender} — revision ${input.revision}`;
}

export function outboxCardText(input: OutboxCardBody): string {
  const review = input.review
    ? `\n\n${input.review.reviewer}: ${input.review.verdict}${
        input.review.reasons ? ` — ${input.review.reasons}` : ''
      }`
    : '';
  return `${outboxHeader(input)}\n\n${input.text}${review}`;
}

export function outboxNoticeText(input: OutboxCardBody): string {
  return `${outboxHeader(input)}\n\n${input.text.length} characters — too long to show in one Telegram message. Approve it in the web UI: Outbox → ${input.personalityId}. Ethos will not show you a partial draft to approve.`;
}

/** The wiring hands over `username ?? userId`. A username gets the `@` the
 *  operator recognises; a bare numeric id is printed as-is. */
function outboxHandle(by: string): string {
  return /^\d+$/.test(by) ? by : `@${by.replace(/^@/, '')}`;
}

function outboxStatusText(status: OutboxCardStatus): string {
  switch (status.kind) {
    case 'approved':
      return `Approved by ${outboxHandle(status.by)} — sending…`;
    case 'sent':
      return `Sent ${status.at}`;
    case 'rejected':
      return status.reason
        ? `Rejected by ${outboxHandle(status.by)} — ${status.reason}`
        : `Rejected by ${outboxHandle(status.by)}`;
    case 'superseded':
      return `Superseded by revision ${status.revision}`;
    case 'expired':
      return 'Expired';
    case 'failed':
      return status.reason ? `Failed — ${status.reason}` : 'Failed — not sent.';
    case 'unconfirmed':
      return (
        'Unconfirmed — the platform did not confirm this send. The delivery ledger owns the ' +
        'retry from here; check the channel before sending it again.'
      );
  }
}

/**
 * What a SETTLED card reads: the header and the whole draft, with the status
 * line under them. The chat stays a record of what was approved, not only that
 * something was — the operator scrolling back a week later sees the text that
 * went out next to who let it out.
 *
 * Falls back to the status line alone when the re-render would not fit in one
 * Telegram message (4096 chars, `maxMessageLength`). The edit MUST land: a
 * refused edit leaves the card on its previous text — "Approved — sending…"
 * over a publication that has already gone out, or failed — and a card that
 * asserts something untrue is worse than a terse one. The draft is never
 * truncated to make room, for the same reason `postOutboxCard` posts a notice
 * instead of a partial: a fragment of a publication is not the publication.
 */
export function outboxSettledText(
  status: OutboxCardStatus,
  card: OutboxCardBody | undefined,
  limit: number,
): string {
  const line = outboxStatusText(status);
  if (!card) return line;
  const full = `${outboxCardText(card)}\n\n${line}`;
  return full.length <= limit ? full : line;
}
