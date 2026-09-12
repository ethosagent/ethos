import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeContentHash } from '../hash';
import {
  LEGAL_FROM,
  type OutboxAction,
  type OutboxObservability,
  type OutboxResult,
  OutboxService,
} from '../service';
import {
  APPROVAL_VALIDITY_MS,
  type OutboxItem,
  type OutboxState,
  PENDING_EXPIRY_MS,
  type ProposeInput,
  SQLiteOutboxStore,
  STALE_THRESHOLD_MS,
} from '../store';

type AuditRow = Parameters<OutboxObservability['recordSafetyApproval']>[0];

const PROPOSAL: ProposeInput = {
  personalityId: 'cmo',
  botKey: 'bot-marketing',
  platform: 'telegram',
  chatId: '-1001234567890',
  text: 'Ethos 0.9 ships today.',
};

const ALL_STATES: readonly OutboxState[] = [
  'awaiting_review',
  'awaiting_approval',
  'approved',
  'sending',
  'sent',
  'unconfirmed',
  'failed',
  'rejected',
  'expired',
];

let store: SQLiteOutboxStore;
let service: OutboxService;
let rows: AuditRow[];
let clock: number;

beforeEach(() => {
  store = new SQLiteOutboxStore(':memory:');
  rows = [];
  clock = 1_700_000_000_000;
  service = new OutboxService({
    store,
    observability: { recordSafetyApproval: (o) => rows.push(o) },
    now: () => clock,
  });
});

afterEach(() => {
  service.close();
});

function proposed(input: ProposeInput = PROPOSAL): OutboxItem {
  return service.propose(input).item;
}

function unwrap(result: OutboxResult<OutboxItem>): OutboxItem {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.error}`);
  return result.value;
}

function reread(id: string): OutboxItem {
  const item = service.get(id);
  if (!item) throw new Error(`item ${id} vanished`);
  return item;
}

function approveCurrent(item: OutboxItem, decidedBy = 'mitesh'): OutboxResult<OutboxItem> {
  const current = reread(item.id);
  return service.approve({
    itemId: item.id,
    revision: current.revision,
    contentHash: current.contentHash,
    decidedBy,
  });
}

/**
 * Drive a fresh item into `state` through the REAL transitions, so the table
 * tests below assert against states the store actually produced rather than
 * states written in by hand.
 */
function driveTo(state: OutboxState): OutboxItem {
  const input =
    state === 'awaiting_review' ? { ...PROPOSAL, approverPersonality: 'brand-editor' } : PROPOSAL;
  const item = proposed(input);
  switch (state) {
    case 'awaiting_review':
    case 'awaiting_approval':
      break;
    case 'approved':
      unwrap(approveCurrent(item));
      break;
    case 'sending':
      unwrap(approveCurrent(item));
      expect(service.claim(item.id)).toBe(true);
      break;
    case 'sent':
      unwrap(approveCurrent(item));
      expect(service.claim(item.id)).toBe(true);
      unwrap(service.markSent(item.id));
      break;
    case 'unconfirmed':
      unwrap(approveCurrent(item));
      expect(service.claim(item.id)).toBe(true);
      unwrap(service.markUnconfirmed(item.id, 'obl-1'));
      break;
    case 'failed':
      unwrap(approveCurrent(item));
      expect(service.claim(item.id)).toBe(true);
      unwrap(service.markFailed(item.id, 'boom'));
      break;
    case 'rejected':
      unwrap(service.reject({ itemId: item.id, reason: 'off message', decidedBy: 'mitesh' }));
      break;
    case 'expired':
      clock += PENDING_EXPIRY_MS + 1;
      expect(service.runExpiry().pending).toBe(1);
      break;
  }
  const after = reread(item.id);
  expect(after.state).toBe(state);
  return after;
}

/** Invoke one action with plausible arguments for it. */
function invoke(action: OutboxAction, item: OutboxItem): OutboxResult<OutboxItem> {
  switch (action) {
    case 'review':
      return service.attachReview(item.id, {
        verdict: 'pass',
        reasons: 'on message',
        revision: item.revision,
        reviewedAt: clock,
      });
    case 'approve':
      return service.approve({
        itemId: item.id,
        revision: item.revision,
        contentHash: item.contentHash,
        decidedBy: 'mitesh',
      });
    case 'edit':
      return service.edit({
        itemId: item.id,
        revision: item.revision,
        text: 'edited text',
        decidedBy: 'mitesh',
      });
    case 'reject':
      return service.reject({ itemId: item.id, reason: 'no', decidedBy: 'mitesh' });
    case 'revoke':
      return service.revoke({ itemId: item.id, decidedBy: 'mitesh' });
    case 'retry':
      return service.retry({ itemId: item.id, decidedBy: 'mitesh' });
    case 'claim':
      // `claim` returns a plain boolean (the same shape `DeliveryLedger.claim`
      // has) because the only thing the dispatcher needs to know is whether it
      // won. Wrapped here so the table below can treat every action alike.
      return service.claim(item.id)
        ? { ok: true, value: item }
        : { ok: false, code: 'conflict', error: 'not claimable' };
    case 'release':
      return service.releaseClaim(item.id);
    case 'sent':
      return service.markSent(item.id);
    case 'unconfirmed':
      return service.markUnconfirmed(item.id, 'obl-1');
    case 'fail':
      return service.markFailed(item.id, 'boom');
  }
}

const ALL_ACTIONS = Object.keys(LEGAL_FROM) as OutboxAction[];

// ---------------------------------------------------------------------------
// The lifecycle table
// ---------------------------------------------------------------------------

describe('OutboxService — the lifecycle table', () => {
  const illegal: Array<[OutboxAction, OutboxState]> = [];
  const legal: Array<[OutboxAction, OutboxState]> = [];
  for (const action of ALL_ACTIONS) {
    for (const state of ALL_STATES) {
      (LEGAL_FROM[action].includes(state) ? legal : illegal).push([action, state]);
    }
  }

  it('covers every action against every state', () => {
    expect(illegal.length + legal.length).toBe(ALL_ACTIONS.length * ALL_STATES.length);
  });

  it.each(illegal)('refuses %s from %s', (action, state) => {
    const item = driveTo(state);
    const result = invoke(action, item);
    expect(result.ok).toBe(false);
    // `claim` has no service-level guard — the conditional UPDATE IS its
    // refusal, and "a peer won" and "wrong state" are the same answer to the
    // only question it asks. Everything else distinguishes the two.
    if (!result.ok && action !== 'claim') expect(result.code).toBe('illegal_transition');
    expect(reread(item.id).state).toBe(state);
  });

  it.each(legal)('allows %s from %s', (action, state) => {
    const item = driveTo(state);
    expect(invoke(action, item).ok).toBe(true);
  });

  it.each(ALL_ACTIONS.filter((a) => a !== 'claim'))(
    'reports %s on an unknown item as not_found',
    (action) => {
      const result = invoke(action, { ...proposed(), id: 'obx_missing' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('not_found');
    },
  );
});

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

describe('OutboxService — binding', () => {
  it('rejects a stale approve with CONFLICT and changes nothing', () => {
    const item = proposed();
    const result = service.approve({
      itemId: item.id,
      revision: 1,
      contentHash: computeContentHash({ ...PROPOSAL, text: 'other' }),
      decidedBy: 'mitesh',
    });
    expect(result).toEqual({ ok: false, code: 'conflict', error: 'changed since you viewed it' });
    expect(reread(item.id).state).toBe('awaiting_approval');
    expect(rows).toEqual([]);
  });

  it('rejects an approve at a revision the approver no longer holds', () => {
    const item = proposed();
    const result = service.approve({
      itemId: item.id,
      revision: 2,
      contentHash: item.contentHash,
      decidedBy: 'mitesh',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('conflict');
  });

  it('voids the approval when a human edits the text', () => {
    const item = proposed();
    const edited = unwrap(
      service.edit({ itemId: item.id, revision: 1, text: 'new text', decidedBy: 'mitesh' }),
    );
    expect(edited.revision).toBe(2);
    expect(edited.approvedBy).toBeUndefined();
    // The revision/hash pair the approver was holding no longer matches.
    const stale = service.approve({
      itemId: item.id,
      revision: 1,
      contentHash: item.contentHash,
      decidedBy: 'mitesh',
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('conflict');
  });

  it('hands the dispatcher the exact approved bytes', () => {
    const item = driveTo('sending');
    const bound = service.verifyBinding(item.id);
    expect(bound.ok).toBe(true);
    if (bound.ok) {
      expect(bound.value.revision.text).toBe(PROPOSAL.text);
      expect(bound.value.item.contentHash).toBe(bound.value.revision.contentHash);
    }
  });

  it('fails the item and sends nothing on a binding mismatch', () => {
    const item = driveTo('sending');
    // A row whose stored revision no longer matches its item hash: a
    // hand-edited database, a bad migration, a restored file. The two earlier
    // enforcement points cannot see any of those.
    rawUpdate('UPDATE outbox_revisions SET text = ? WHERE item_id = ? AND revision = 1', [
      'tampered',
      item.id,
    ]);

    const result = service.verifyBinding(item.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('binding_mismatch');
    const after = reread(item.id);
    expect(after.state).toBe('failed');
    expect(after.failureReason).toBe('binding mismatch');
  });

  it('fails the item when the current revision row is missing entirely', () => {
    const item = driveTo('sending');
    rawUpdate('DELETE FROM outbox_revisions WHERE item_id = ?', [item.id]);
    const result = service.verifyBinding(item.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('binding_mismatch');
    expect(reread(item.id).state).toBe('failed');
  });

  it('refuses to verify a binding on an item nobody claimed', () => {
    const item = driveTo('approved');
    const result = service.verifyBinding(item.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('illegal_transition');
    expect(reread(item.id).state).toBe('approved');
  });

  it('reports an unknown item as not_found', () => {
    const result = service.verifyBinding('obx_missing');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
  });
});

/** Reach past the store's API to corrupt a row — the only way to reach the
 *  third binding check, which exists for exactly the cases the API cannot
 *  produce. */
function rawUpdate(sql: string, params: unknown[]): void {
  (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
    .prepare(sql)
    .run(...params);
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

describe('OutboxService — audit trail', () => {
  it('writes exactly one row per decision, with the documented code', () => {
    const item = proposed();

    unwrap(service.edit({ itemId: item.id, revision: 1, text: 'v2', decidedBy: 'mitesh' }));
    unwrap(approveCurrent(item));
    unwrap(service.revoke({ itemId: item.id, decidedBy: 'mitesh' }));
    unwrap(approveCurrent(item));
    expect(service.claim(item.id)).toBe(true);
    unwrap(service.markFailed(item.id, 'boom'));
    unwrap(service.retry({ itemId: item.id, decidedBy: 'mitesh' }));

    expect(rows.map((r) => r.code)).toEqual([
      'outbox.edit',
      'outbox.approve',
      'outbox.revoke',
      'outbox.approve',
      'outbox.retry',
    ]);
  });

  it('writes one outbox.reject row', () => {
    const item = proposed();
    unwrap(service.reject({ itemId: item.id, reason: 'off message', decidedBy: 'mitesh' }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.code).toBe('outbox.reject');
    expect(rows[0]?.decision).toBe('denied');
    expect(rows[0]?.severity).toBe('warn');
    expect(rows[0]?.cause).toContain('off message');
  });

  it('never records a publication as auto-approved', () => {
    // A human decided, or nothing decided. `auto` would say a machine let this
    // out, which is the one thing the outbox exists to prevent (O-D4).
    const item = driveTo('failed');
    unwrap(service.retry({ itemId: item.id, decidedBy: 'mitesh' }));
    expect(rows.every((r) => r.decision !== 'auto')).toBe(true);
  });

  it('carries the binding in details, and never the text', () => {
    const item = proposed();
    unwrap(approveCurrent(item));
    expect(rows[0]?.details).toMatchObject({
      itemId: item.id,
      personalityId: 'cmo',
      botKey: 'bot-marketing',
      platform: 'telegram',
      chatId: '-1001234567890',
      revision: 1,
      contentHash: item.contentHash,
      state: 'approved',
      decidedBy: 'mitesh',
    });
    expect(JSON.stringify(rows[0]?.details)).not.toContain(PROPOSAL.text);
  });

  it('writes nothing for a refused decision', () => {
    const item = driveTo('sent');
    expect(service.revoke({ itemId: item.id, decidedBy: 'mitesh' }).ok).toBe(false);
    expect(service.reject({ itemId: item.id, reason: 'x', decidedBy: 'mitesh' }).ok).toBe(false);
    // Only the approve that `driveTo('sent')` itself made.
    expect(rows.map((r) => r.code)).toEqual(['outbox.approve']);
  });

  it('writes nothing for a proposal, an expiry, or a delivery outcome', () => {
    const item = driveTo('sending');
    unwrap(service.markSent(item.id));
    service.runExpiry();
    expect(rows.map((r) => r.code)).toEqual(['outbox.approve']);
  });

  it('never breaks a decision when the sink throws', () => {
    const failing = new OutboxService({
      store,
      observability: {
        recordSafetyApproval: () => {
          throw new Error('sink down');
        },
      },
      now: () => clock,
    });
    const item = failing.propose({ ...PROPOSAL, text: 'audit fail-open' }).item;
    const result = failing.approve({
      itemId: item.id,
      revision: 1,
      contentHash: item.contentHash,
      decidedBy: 'mitesh',
    });
    expect(result.ok).toBe(true);
    expect(failing.get(item.id)?.state).toBe('approved');
  });

  it('works with no sink at all', () => {
    const quiet = new OutboxService({ store, now: () => clock });
    const item = quiet.propose({ ...PROPOSAL, text: 'no sink' }).item;
    expect(
      quiet.approve({
        itemId: item.id,
        revision: 1,
        contentHash: item.contentHash,
        decidedBy: 'mitesh',
      }).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

describe('OutboxService — fixed windows', () => {
  it('expires a pending item after 7 days and an approval after 24h', () => {
    const pending = proposed();
    const toApprove = proposed({ ...PROPOSAL, text: 'second post' });
    unwrap(approveCurrent(toApprove));

    clock += APPROVAL_VALIDITY_MS + 1;
    expect(service.runExpiry()).toEqual({ pending: 0, approvals: 1 });
    expect(reread(toApprove.id).state).toBe('expired');
    expect(reread(pending.id).state).toBe('awaiting_approval');

    clock += PENDING_EXPIRY_MS;
    expect(service.runExpiry()).toEqual({ pending: 1, approvals: 0 });
    expect(reread(pending.id).state).toBe('expired');
  });

  it('surfaces stale reviews and stale claims after 10 minutes', () => {
    // Distinct text: `approverPersonality` is not part of the binding, so the
    // same text under a reviewer is the SAME proposal and comes back as the
    // existing item.
    const reviewing = proposed({
      ...PROPOSAL,
      text: 'awaiting a reviewer',
      approverPersonality: 'brand-editor',
    });
    const sending = driveTo('sending');
    expect(service.listStaleReviews()).toEqual([]);
    expect(service.listStaleSending()).toEqual([]);

    clock += STALE_THRESHOLD_MS + 1;
    expect(service.listStaleReviews().map((i) => i.id)).toEqual([reviewing.id]);
    expect(service.listStaleSending().map((i) => i.id)).toEqual([sending.id]);
  });

  it('releases a stale review to the human with an unavailable receipt', () => {
    const item = proposed({ ...PROPOSAL, approverPersonality: 'nobody-home' });
    clock += STALE_THRESHOLD_MS + 1;
    const released = unwrap(
      service.attachReview(item.id, {
        verdict: 'unavailable',
        reasons: 'reviewer personality nobody-home is not installed',
        revision: 1,
        reviewedAt: clock,
      }),
    );
    // The item still reaches the human — an unknown reviewer never blocks it.
    expect(released.state).toBe('awaiting_approval');
    expect(released.review?.verdict).toBe('unavailable');
    expect(rows).toEqual([]);
  });
});

describe('OutboxService — delivery pool', () => {
  it('lists claimable items for this process bots only', () => {
    const mine = driveTo('approved');
    const theirs = proposed({ ...PROPOSAL, botKey: 'bot-support', text: 'other bot' });
    unwrap(approveCurrent(theirs));
    expect(service.listClaimable(['bot-marketing']).map((i) => i.id)).toEqual([mine.id]);
  });

  it('releases a claim back to approved on a pre-send refusal', () => {
    const item = driveTo('sending');
    const released = unwrap(service.releaseClaim(item.id));
    expect(released.state).toBe('approved');
    expect(released.approvedBy).toBe('mitesh');
  });

  it('keeps the obligation id when the platform did not confirm', () => {
    const item = driveTo('sending');
    const after = unwrap(service.markUnconfirmed(item.id, 'obl-42'));
    expect(after.state).toBe('unconfirmed');
    expect(after.obligationId).toBe('obl-42');
    // The outbox never resends: nothing moves an unconfirmed item onward.
    expect(service.retry({ itemId: item.id, decidedBy: 'mitesh' }).ok).toBe(false);
    expect(service.listClaimable(['bot-marketing'])).toEqual([]);
  });
});
