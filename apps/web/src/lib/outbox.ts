import type { OutboxItemView } from '@ethosagent/web-contracts';

// Pure derivations behind the Outbox pane (plan/phases/trust-before-reach.md
// Part 2, O-T10) — sectioning, labels, the waiting-on-a-bot banner and the
// approved item's timeline. No React and no fetching, the same split
// `scopeNav.ts` and `teamPresence.ts` already use, so the decisions that
// matter here are unit-testable without a DOM.
//
// Everything below reads ONLY fields `OutboxItemView` actually carries. Where
// the approved mockup showed something the RPC does not return — a chat's
// human title, whether a bot's process is up — the wording here says what is
// known instead of inventing a field.

/** The nine wire states, as the item view spells them. */
export type OutboxItemState = OutboxItemView['state'];

export type OutboxSectionKey = 'needs_you' | 'approved' | 'sent' | 'terminal';

export interface OutboxSection {
  key: OutboxSectionKey;
  label: string;
  states: readonly OutboxItemState[];
}

/**
 * The four sections, in render order. Every state belongs to exactly one of
 * them — `outbox.test.ts` pins that against `OutboxStateSchema`, so a state
 * added to the wire enum cannot quietly render nowhere.
 *
 * `awaiting_review` sits in "Needs your approval" rather than in a fifth
 * section: the reviewer is advisory (O-D4), the item is already the human's to
 * decide, and it moves on by itself. The pane just shows no buttons yet.
 */
export const OUTBOX_SECTIONS: readonly OutboxSection[] = [
  {
    key: 'needs_you',
    label: 'Needs your approval',
    states: ['awaiting_review', 'awaiting_approval'],
  },
  { key: 'approved', label: 'Approved · sending', states: ['approved', 'sending'] },
  { key: 'sent', label: 'Sent', states: ['sent', 'unconfirmed'] },
  { key: 'terminal', label: 'Rejected & expired', states: ['rejected', 'expired', 'failed'] },
];

/** The items of one section, newest first — the order `outbox.list` returns. */
export function sectionItems(
  items: readonly OutboxItemView[],
  section: OutboxSection,
): OutboxItemView[] {
  return items.filter((item) => section.states.includes(item.state));
}

/**
 * How long an `approved` row may sit unclaimed before the pane says so.
 *
 * The gateway dispatcher claims an approved row on a 5s poll (O-D9), so a row
 * still unclaimed a minute later is not slow — nothing that serves its bot is
 * running. That is an INFERENCE, which is why the banner copy says the post is
 * waiting rather than that it failed: no RPC reports which adapters are up
 * (`TeamChannels` hits the same wall and says so).
 */
export const UNCLAIMED_APPROVED_GRACE_MS = 60_000;

/** Approved items nothing has claimed — what the banner counts. */
export function waitingOnDispatcher(
  items: readonly OutboxItemView[],
  now: number = Date.now(),
): OutboxItemView[] {
  return items.filter(
    (item) =>
      item.state === 'approved' &&
      item.claimedAt === null &&
      now - (item.approvedAt ?? item.updatedAt) > UNCLAIMED_APPROVED_GRACE_MS,
  );
}

/** `telegram` → `Telegram`. The platform id is the only name we are given. */
export function platformLabel(platform: string): string {
  return platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : platform;
}

/**
 * The destination chip's text.
 *
 * `Telegram · -1002145…` — the chat ID and nothing prettier. The item view
 * carries no chat title, so a friendly room name here would be invented; the
 * id is what the ledger, the audit row and the platform all agree on.
 */
export function destinationLabel(item: OutboxItemView): string {
  const base = `${platformLabel(item.platform)} · ${item.chatId}`;
  return item.threadId === null ? base : `${base} · thread ${item.threadId}`;
}

/**
 * The sending bot's chip text: `@handle` when the platform told us one,
 * otherwise the botKey itself — which is what the dispatcher matches on.
 */
export function botLabel(botKey: string, usernames: ReadonlyMap<string, string>): string {
  const username = usernames.get(botKey);
  return username ? `@${username}` : botKey;
}

/** Coarse relative time. Epoch ms in, no calendar dates out. */
export function formatWhen(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/** Wall-clock for the timeline's right column. */
export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

export type TimelineIcon = '✓' | '⏳' | '✗';

export interface TimelineRow {
  key: string;
  icon: TimelineIcon;
  text: string;
  /** Wall-clock, or `—` for a step that has not happened. */
  time: string;
  done: boolean;
}

/**
 * The approved item's receipt: drafted → reviewed → approved → handed to the
 * ledger → confirmed. Each row is drawn from a timestamp the item carries, so
 * a step with no timestamp renders as pending rather than as a guess.
 *
 * `you` appears only when `approvedBy` is this tab's own clientId — another
 * operator's approval keeps their id, because "you" would be a lie.
 */
export function timelineRows(
  item: OutboxItemView,
  opts: { clientId: string; botLabel: string },
): TimelineRow[] {
  const rows: TimelineRow[] = [
    {
      key: 'drafted',
      icon: '✓',
      text: `Drafted by ${item.personalityId}`,
      time: formatClock(item.createdAt),
      done: true,
    },
  ];
  if (item.review) {
    const who = item.approverPersonality ?? 'the reviewer';
    rows.push({
      key: 'reviewed',
      icon: item.review.verdict === 'fail' ? '✗' : '✓',
      text: `Reviewed by ${who} — ${item.review.verdict.toUpperCase()}`,
      time: formatClock(item.review.reviewedAt),
      done: true,
    });
  }
  if (item.approvedAt !== null) {
    const who = item.approvedBy === opts.clientId ? 'you' : (item.approvedBy ?? 'an operator');
    rows.push({
      key: 'approved',
      icon: '✓',
      text: `Approved by ${who}`,
      time: formatClock(item.approvedAt),
      done: true,
    });
  }
  rows.push(
    item.claimedAt === null
      ? {
          key: 'claimed',
          icon: '⏳',
          text: `Waiting for a gateway running ${opts.botLabel}`,
          time: '—',
          done: false,
        }
      : {
          key: 'claimed',
          icon: '✓',
          text: 'Handed to the delivery ledger',
          time: formatClock(item.claimedAt),
          done: true,
        },
  );
  rows.push(
    item.sentAt === null
      ? { key: 'sent', icon: '⏳', text: 'Not sent yet', time: '—', done: false }
      : {
          key: 'sent',
          icon: '✓',
          text: `Confirmed by ${platformLabel(item.platform)}`,
          time: formatClock(item.sentAt),
          done: true,
        },
  );
  return rows;
}

export interface StatePill {
  icon: TimelineIcon;
  word: string;
  /** Pill tone — colour is never the only signal, the word above is. */
  tone: 'wait' | 'ok' | 'bad' | 'muted';
}

/** Icon AND word for every state, so the pill survives both skins and
 *  colour-blindness (DESIGN.md "Semantic colors" — never colour alone). */
export function statePill(item: OutboxItemView): StatePill {
  switch (item.state) {
    case 'awaiting_review':
      return { icon: '⏳', word: 'In review', tone: 'wait' };
    case 'awaiting_approval':
      return { icon: '⏳', word: 'Awaiting approval', tone: 'wait' };
    case 'approved':
      return { icon: '✓', word: 'Approved', tone: 'ok' };
    case 'sending':
      return { icon: '⏳', word: 'Sending', tone: 'wait' };
    case 'sent':
      return {
        icon: '✓',
        word: item.sentAt === null ? 'Sent' : `Sent ${formatClock(item.sentAt)}`,
        tone: 'ok',
      };
    case 'unconfirmed':
      return { icon: '⏳', word: 'Unconfirmed', tone: 'muted' };
    case 'rejected':
      return { icon: '✗', word: 'Rejected', tone: 'bad' };
    case 'expired':
      return { icon: '✗', word: 'Expired', tone: 'muted' };
    default:
      return { icon: '✗', word: 'Failed', tone: 'muted' };
  }
}

/** The dense terminal row's trailing note — why it ended where it did. */
export function terminalNote(item: OutboxItemView): string {
  if (item.state === 'rejected') {
    return item.rejectionReason ? `rejected — "${item.rejectionReason}"` : 'rejected';
  }
  if (item.state === 'expired') return 'expired unapproved';
  return item.failureReason ?? 'failed';
}

/**
 * The "revision 2 · edited" line.
 *
 * Only a human edit mints a revision above 1 (`SQLiteOutboxStore.edit` is the
 * one writer of `outbox_revisions` past the proposal), so `> 1` means a person
 * changed the text. WHICH person is not in `outbox.list` — the authors live on
 * `outbox.get`'s revision history — so this says "edited", not "edited by you".
 */
export function revisionLine(item: OutboxItemView): string {
  return item.revision > 1 ? `revision ${item.revision} · edited` : `revision ${item.revision}`;
}
