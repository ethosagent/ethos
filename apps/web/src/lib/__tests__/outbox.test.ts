import { type OutboxItemView, OutboxStateSchema } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  botLabel,
  destinationLabel,
  formatWhen,
  OUTBOX_SECTIONS,
  revisionLine,
  sectionItems,
  statePill,
  terminalNote,
  timelineRows,
  UNCLAIMED_APPROVED_GRACE_MS,
  waitingOnDispatcher,
} from '../outbox';

// The Outbox pane's derivations (plan/phases/trust-before-reach.md O-T10).
// Everything the pane decides before it renders anything lives here, so the
// decisions are pinned without a DOM.

const NOW = 1_757_000_000_000;

function item(over: Partial<OutboxItemView> = {}): OutboxItemView {
  return {
    id: 'obx_1',
    personalityId: 'cmo',
    botKey: 'bk_abc',
    platform: 'telegram',
    chatId: '-1002145',
    threadId: null,
    revision: 1,
    contentHash: 'sha256:aaa',
    text: 'Ethos 0.9 is out.',
    state: 'awaiting_approval',
    createdAt: NOW - 600_000,
    updatedAt: NOW - 600_000,
    approverPersonality: null,
    review: null,
    approvedBy: null,
    approvedAt: null,
    approvedRevision: null,
    claimedAt: null,
    sentAt: null,
    obligationId: null,
    failureReason: null,
    rejectionReason: null,
    originSessionKey: null,
    ...over,
  };
}

describe('outbox sections', () => {
  it('every wire state lands in exactly one section', () => {
    // The pane renders sections, not states. A state added to the wire enum
    // without a home here would silently render nowhere.
    const covered = OUTBOX_SECTIONS.flatMap((s) => s.states);
    expect([...covered].sort()).toEqual([...OutboxStateSchema.options].sort());
    expect(new Set(covered).size).toBe(covered.length);
  });

  it('awaiting_review sits with awaiting_approval — the reviewer is advisory', () => {
    const needsYou = OUTBOX_SECTIONS[0];
    expect(needsYou?.key).toBe('needs_you');
    expect(needsYou?.states).toContain('awaiting_review');
  });

  it('splits items by section, preserving list order', () => {
    const items = [
      item({ id: 'a', state: 'sent' }),
      item({ id: 'b', state: 'awaiting_approval' }),
      item({ id: 'c', state: 'unconfirmed' }),
    ];
    const sent = OUTBOX_SECTIONS[2];
    if (!sent) throw new Error('missing section');
    expect(sectionItems(items, sent).map((i) => i.id)).toEqual(['a', 'c']);
  });
});

describe('waitingOnDispatcher', () => {
  it('counts an approved item nothing has claimed past the grace window', () => {
    const stale = item({
      state: 'approved',
      approvedAt: NOW - UNCLAIMED_APPROVED_GRACE_MS - 1,
    });
    expect(waitingOnDispatcher([stale], NOW)).toHaveLength(1);
  });

  it('ignores a fresh approval and anything already claimed', () => {
    const fresh = item({ state: 'approved', approvedAt: NOW - 1_000 });
    const claimed = item({
      state: 'approved',
      approvedAt: NOW - 600_000,
      claimedAt: NOW - 500_000,
    });
    expect(waitingOnDispatcher([fresh, claimed], NOW)).toEqual([]);
  });
});

describe('labels', () => {
  it('names the destination by platform and chat id, and says when it is a thread', () => {
    expect(destinationLabel(item())).toBe('Telegram · -1002145');
    expect(destinationLabel(item({ threadId: '42' }))).toBe('Telegram · -1002145 · thread 42');
  });

  it('prefers a handle for the sender and falls back to the botKey', () => {
    const handles = new Map([['bk_abc', 'EthosMarketingBot']]);
    expect(botLabel('bk_abc', handles)).toBe('@EthosMarketingBot');
    expect(botLabel('bk_zzz', handles)).toBe('bk_zzz');
  });

  it('marks an edited item without claiming who edited it', () => {
    expect(revisionLine(item())).toBe('revision 1');
    expect(revisionLine(item({ revision: 3 }))).toBe('revision 3 · edited');
  });

  it('gives every state an icon AND a word', () => {
    for (const state of OutboxStateSchema.options) {
      const pill = statePill(item({ state }));
      expect(pill.icon.length).toBeGreaterThan(0);
      expect(pill.word.length).toBeGreaterThan(0);
    }
    expect(statePill(item({ state: 'unconfirmed' })).word).toBe('Unconfirmed');
  });

  it('says why a terminal item ended where it did', () => {
    expect(terminalNote(item({ state: 'rejected', rejectionReason: 'superlative' }))).toBe(
      'rejected — "superlative"',
    );
    expect(terminalNote(item({ state: 'expired' }))).toBe('expired unapproved');
    expect(
      terminalNote(
        item({ state: 'failed', failureReason: 'interrupted before the platform call' }),
      ),
    ).toBe('interrupted before the platform call');
  });

  it('ages relative, never as a calendar date', () => {
    expect(formatWhen(NOW - 30_000, NOW)).toBe('just now');
    expect(formatWhen(NOW - 300_000, NOW)).toBe('5m ago');
    expect(formatWhen(NOW - 7_200_000, NOW)).toBe('2h ago');
    expect(formatWhen(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
  });
});

describe('timelineRows', () => {
  it('runs drafted → reviewed → approved → handed over → confirmed', () => {
    const approved = item({
      state: 'approved',
      review: { verdict: 'pass', reasons: 'every claim maps', revision: 1, reviewedAt: NOW - 500 },
      approverPersonality: 'brand-editor',
      approvedBy: 'tab-1',
      approvedAt: NOW - 400,
      approvedRevision: 1,
      claimedAt: NOW - 300,
      sentAt: NOW - 200,
    });
    const rows = timelineRows(approved, { clientId: 'tab-1', botLabel: '@bot' });
    expect(rows.map((r) => r.key)).toEqual(['drafted', 'reviewed', 'approved', 'claimed', 'sent']);
    expect(rows.every((r) => r.done)).toBe(true);
    expect(rows[2]?.text).toBe('Approved by you');
  });

  it('keeps another operator’s name instead of saying "you"', () => {
    const approved = item({ state: 'approved', approvedBy: 'tab-9', approvedAt: NOW - 400 });
    const rows = timelineRows(approved, { clientId: 'tab-1', botLabel: '@bot' });
    expect(rows[1]?.text).toBe('Approved by tab-9');
  });

  it('shows an unclaimed approval as waiting on the bot, not as failed', () => {
    const rows = timelineRows(item({ state: 'approved', approvedAt: NOW - 400 }), {
      clientId: 'tab-1',
      botLabel: '@EthosMarketingBot',
    });
    const claimed = rows.find((r) => r.key === 'claimed');
    expect(claimed?.done).toBe(false);
    expect(claimed?.text).toBe('Waiting for a gateway running @EthosMarketingBot');
    expect(claimed?.time).toBe('—');
  });
});
