import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeContentHash } from '../hash';
import {
  ACTIVE_STATES,
  APPROVAL_VALIDITY_MS,
  type OutboxItem,
  PENDING_EXPIRY_MS,
  type ProposeInput,
  SQLiteOutboxStore,
  STALE_THRESHOLD_MS,
} from '../store';

const PROPOSAL: ProposeInput = {
  personalityId: 'cmo',
  botKey: 'bot-marketing',
  platform: 'telegram',
  chatId: '-1001234567890',
  text: 'Ethos 0.9 ships today.',
};

let store: SQLiteOutboxStore;

beforeEach(() => {
  store = new SQLiteOutboxStore(':memory:');
});

afterEach(() => {
  store.close();
});

/** Propose and approve in one step, for tests about what happens afterwards. */
function approved(input: ProposeInput = PROPOSAL, now = Date.now()): OutboxItem {
  const { item } = store.propose(input, now);
  expect(store.approve(item.id, item.revision, item.contentHash, 'mitesh', now)).toBe(true);
  const after = store.get(item.id);
  if (!after) throw new Error('item vanished');
  return after;
}

describe('SQLiteOutboxStore — propose', () => {
  it('opens awaiting_approval when no reviewer is named', () => {
    const { item, created } = store.propose(PROPOSAL);
    expect(created).toBe(true);
    expect(item.state).toBe('awaiting_approval');
    expect(item.revision).toBe(1);
    expect(item.contentHash).toBe(computeContentHash(PROPOSAL));
    expect(item.id.startsWith('obx_')).toBe(true);
  });

  it('opens awaiting_review when the policy names a reviewer', () => {
    const { item } = store.propose({ ...PROPOSAL, approverPersonality: 'brand-editor' });
    expect(item.state).toBe('awaiting_review');
    expect(item.approverPersonality).toBe('brand-editor');
  });

  it('writes revision 1 authored by the agent', () => {
    const { item } = store.propose(PROPOSAL);
    const revisions = store.listRevisions(item.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.text).toBe(PROPOSAL.text);
    expect(revisions[0]?.author).toBe('agent');
  });

  it('normalizes an empty thread id to no thread, hash included', () => {
    // The row stores NULL for `''`, so the hash has to agree: an item bound to
    // a thread value its own row does not hold fails `verifyBinding` at the
    // last step before delivery, every time.
    const { item } = store.propose({ ...PROPOSAL, threadId: '' });
    expect(item.threadId).toBeUndefined();
    expect(item.contentHash).toBe(computeContentHash(PROPOSAL));
    expect(store.getRevision(item.id, 1)?.contentHash).toBe(item.contentHash);
  });

  it('returns the existing item for a repeat proposal while one is active', () => {
    // Idempotent PROPOSAL: a model that retries its tool call must not put two
    // identical cards in front of the same human.
    const first = store.propose(PROPOSAL);
    const second = store.propose(PROPOSAL);
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    expect(store.listByPersonality('cmo')).toHaveLength(1);
  });

  it.each(ACTIVE_STATES)('treats %s as active for the idempotency check', (state) => {
    // Driven through the real transitions rather than by writing a state in:
    // the point is that every state the lifecycle can still move out of blocks
    // a duplicate card.
    const input =
      state === 'awaiting_review' ? { ...PROPOSAL, approverPersonality: 'brand-editor' } : PROPOSAL;
    const { item } = store.propose(input);
    if (state !== 'awaiting_review' && state !== 'awaiting_approval') {
      expect(store.approve(item.id, 1, item.contentHash, 'mitesh')).toBe(true);
    }
    if (state === 'sending' || state === 'failed') expect(store.claim(item.id)).toBe(true);
    if (state === 'failed') expect(store.markFailed(item.id, 'boom')).toBe(true);
    expect(store.get(item.id)?.state).toBe(state);

    const repeat = store.propose(input);
    expect(repeat.created).toBe(false);
    expect(repeat.item.id).toBe(item.id);
  });

  it('proposes afresh once the earlier item reached a terminal state', () => {
    const { item } = store.propose(PROPOSAL);
    expect(store.reject(item.id, 'off message')).toBe(true);
    const second = store.propose(PROPOSAL);
    expect(second.created).toBe(true);
    expect(second.item.id).not.toBe(item.id);
  });

  it('does not collapse the same text proposed by a different personality', () => {
    const a = store.propose(PROPOSAL);
    const b = store.propose({ ...PROPOSAL, personalityId: 'cto' });
    expect(b.created).toBe(true);
    expect(b.item.id).not.toBe(a.item.id);
  });
});

describe('SQLiteOutboxStore — the bound approve', () => {
  it('approves the revision and hash the approver read', () => {
    const item = approved();
    expect(item.state).toBe('approved');
    expect(item.approvedBy).toBe('mitesh');
    expect(item.approvedRevision).toBe(1);
  });

  it('touches zero rows for a stale revision', () => {
    const { item } = store.propose(PROPOSAL);
    expect(store.approve(item.id, 2, item.contentHash, 'mitesh')).toBe(false);
    expect(store.get(item.id)?.state).toBe('awaiting_approval');
  });

  it('touches zero rows for a stale hash', () => {
    const { item } = store.propose(PROPOSAL);
    const stale = computeContentHash({ ...PROPOSAL, text: 'something else' });
    expect(store.approve(item.id, 1, stale, 'mitesh')).toBe(false);
    expect(store.get(item.id)?.state).toBe('awaiting_approval');
  });

  it('touches zero rows once the item has left awaiting_approval', () => {
    const item = approved();
    expect(store.approve(item.id, item.revision, item.contentHash, 'someone-else')).toBe(false);
    expect(store.get(item.id)?.approvedBy).toBe('mitesh');
  });
});

describe('SQLiteOutboxStore — edit', () => {
  it('writes revision n+1 with a new hash', () => {
    const { item } = store.propose(PROPOSAL);
    const edited = store.edit(item.id, 1, 'Ethos 0.9 ships tomorrow.', 'mitesh');
    expect(edited?.revision).toBe(2);
    expect(edited?.contentHash).toBe(
      computeContentHash({ ...PROPOSAL, text: 'Ethos 0.9 ships tomorrow.' }),
    );
    expect(store.listRevisions(item.id).map((r) => r.revision)).toEqual([1, 2]);
    // Revisions are immutable: revision 1 still says what it said.
    expect(store.getRevision(item.id, 1)?.text).toBe(PROPOSAL.text);
  });

  it('voids an approval that belonged to the previous revision', () => {
    const { item } = store.propose(PROPOSAL);
    // Approve, revoke back to awaiting_approval, then edit — the approval
    // columns must not survive into the new revision.
    expect(store.approve(item.id, 1, item.contentHash, 'mitesh')).toBe(true);
    expect(store.revoke(item.id)).toBe(true);
    const edited = store.edit(item.id, 1, 'Ethos 0.9 ships tomorrow.', 'mitesh');
    expect(edited?.state).toBe('awaiting_approval');
    expect(edited?.approvedBy).toBeUndefined();
    expect(edited?.approvedRevision).toBeUndefined();
    // The stale approval no longer matches: revision 1's hash is not current.
    expect(store.approve(item.id, 1, item.contentHash, 'mitesh')).toBe(false);
  });

  it('refuses an edit from a revision that is no longer current', () => {
    const { item } = store.propose(PROPOSAL);
    expect(store.edit(item.id, 1, 'first edit', 'mitesh')).not.toBeNull();
    // A second tab still holding revision 1.
    expect(store.edit(item.id, 1, 'second edit', 'someone-else')).toBeNull();
    expect(store.get(item.id)?.revision).toBe(2);
  });

  it('refuses an edit on an item that is not awaiting approval', () => {
    const item = approved();
    expect(store.edit(item.id, item.revision, 'too late', 'mitesh')).toBeNull();
  });

  it('returns null for an unknown item', () => {
    expect(store.edit('obx_nope', 1, 'x', 'mitesh')).toBeNull();
  });
});

describe('SQLiteOutboxStore — reject, revoke, retry', () => {
  it('rejects only from awaiting_approval', () => {
    const { item } = store.propose(PROPOSAL);
    expect(store.reject(item.id, 'off message')).toBe(true);
    expect(store.get(item.id)?.state).toBe('rejected');
    expect(store.get(item.id)?.rejectionReason).toBe('off message');
    expect(store.reject(item.id, 'again')).toBe(false);
  });

  it('revokes an approval before the claim, and loses to it afterwards', () => {
    const item = approved();
    expect(store.claim(item.id)).toBe(true);
    // The conditional UPDATE settles the race: the claim already happened.
    expect(store.revoke(item.id)).toBe(false);
    expect(store.get(item.id)?.state).toBe('sending');
  });

  it('returns a revoked item to the human with no approval on it', () => {
    const item = approved();
    expect(store.revoke(item.id)).toBe(true);
    const after = store.get(item.id);
    expect(after?.state).toBe('awaiting_approval');
    expect(after?.approvedBy).toBeUndefined();
  });

  it('retries a failed item at the same revision', () => {
    const item = approved();
    expect(store.claim(item.id)).toBe(true);
    expect(store.markFailed(item.id, 'interrupted before the platform call')).toBe(true);
    expect(store.retry(item.id, 'mitesh')).toBe(true);
    const after = store.get(item.id);
    expect(after?.state).toBe('approved');
    expect(after?.revision).toBe(1);
    expect(after?.approvedRevision).toBe(1);
    expect(after?.failureReason).toBeUndefined();
    expect(after?.claimedAt).toBeUndefined();
  });

  it('refuses a retry on anything but a failed item', () => {
    const item = approved();
    expect(store.retry(item.id, 'mitesh')).toBe(false);
  });
});

describe('SQLiteOutboxStore — claim', () => {
  it('lists only approved rows for the bots this process owns', () => {
    const mine = approved();
    approved({ ...PROPOSAL, botKey: 'bot-support', text: 'different text' });
    const claimable = store.listClaimable(['bot-marketing']);
    expect(claimable.map((i) => i.id)).toEqual([mine.id]);
    expect(store.listClaimable([])).toEqual([]);
  });

  it('does not list an item that is not approved', () => {
    store.propose(PROPOSAL);
    expect(store.listClaimable(['bot-marketing'])).toEqual([]);
  });

  it('lets exactly one of two peers sharing the file claim a row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ethos-outbox-'));
    const path = join(dir, 'outbox.db');
    const a = new SQLiteOutboxStore(path);
    const b = new SQLiteOutboxStore(path);
    try {
      const { item } = a.propose(PROPOSAL);
      expect(a.approve(item.id, 1, item.contentHash, 'mitesh')).toBe(true);
      // Both peers see it as claimable; only one UPDATE changes a row.
      expect(a.listClaimable(['bot-marketing'])).toHaveLength(1);
      expect(b.listClaimable(['bot-marketing'])).toHaveLength(1);
      const results = [a.claim(item.id), b.claim(item.id)];
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(b.get(item.id)?.state).toBe('sending');
    } finally {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releases a claim back to approved, approval intact', () => {
    const item = approved();
    expect(store.claim(item.id)).toBe(true);
    expect(store.releaseClaim(item.id)).toBe(true);
    const after = store.get(item.id);
    expect(after?.state).toBe('approved');
    expect(after?.approvedBy).toBe('mitesh');
    expect(after?.claimedAt).toBeUndefined();
  });
});

describe('SQLiteOutboxStore — outcomes', () => {
  it('marks sent only from sending', () => {
    const item = approved();
    expect(store.markSent(item.id)).toBe(false);
    expect(store.claim(item.id)).toBe(true);
    expect(store.markSent(item.id)).toBe(true);
    expect(store.get(item.id)?.sentAt).toBeTypeOf('number');
  });

  it('keeps the obligation id on an unconfirmed item', () => {
    const item = approved();
    expect(store.claim(item.id)).toBe(true);
    expect(store.markUnconfirmed(item.id, 'obl-1')).toBe(true);
    const after = store.get(item.id);
    expect(after?.state).toBe('unconfirmed');
    expect(after?.obligationId).toBe('obl-1');
  });

  it('refuses to fail an item nobody claimed', () => {
    // A dispatcher that failed an unclaimed `approved` row would be failing a
    // publication a peer process may be delivering right now.
    const item = approved();
    expect(store.markFailed(item.id, 'binding mismatch')).toBe(false);
    expect(store.get(item.id)?.state).toBe('approved');
  });
});

describe('SQLiteOutboxStore — expiry and staleness', () => {
  it('expires items waiting on a human past the 7-day window', () => {
    const now = Date.now();
    const old = now - PENDING_EXPIRY_MS - 1;
    store.propose(PROPOSAL, old);
    store.propose({ ...PROPOSAL, text: 'fresh' }, now);
    expect(store.expirePending(now)).toBe(1);
    expect(store.listByState(['expired'])).toHaveLength(1);
    expect(store.listByState(['awaiting_approval'])).toHaveLength(1);
  });

  it('measures the pending window from the proposal, not the last touch', () => {
    // An edit or a reviewer receipt must not restart the week's clock — that is
    // how a stale publication lives forever.
    const now = Date.now();
    const old = now - PENDING_EXPIRY_MS - 1;
    const { item } = store.propose(PROPOSAL, old);
    expect(store.edit(item.id, 1, 'touched yesterday', 'mitesh', now - 1000)).not.toBeNull();
    expect(store.expirePending(now)).toBe(1);
  });

  it('expires an approval nobody delivered inside 24h', () => {
    const now = Date.now();
    approved(PROPOSAL, now - APPROVAL_VALIDITY_MS - 1);
    approved({ ...PROPOSAL, text: 'fresh' }, now);
    expect(store.expireApprovals(now)).toBe(1);
    expect(store.listByState(['approved'])).toHaveLength(1);
  });

  it('lists stale reviews and stale claims past the 10-minute threshold', () => {
    const now = Date.now();
    const stale = now - STALE_THRESHOLD_MS - 1;
    const { item: reviewing } = store.propose(
      { ...PROPOSAL, approverPersonality: 'brand-editor' },
      stale,
    );
    const sending = approved({ ...PROPOSAL, text: 'claimed long ago' }, stale);
    expect(store.claim(sending.id, stale)).toBe(true);

    expect(store.listStaleReviews(now).map((i) => i.id)).toEqual([reviewing.id]);
    expect(store.listStaleSending(now).map((i) => i.id)).toEqual([sending.id]);
    // Nothing is stale a moment after it was written.
    expect(store.listStaleReviews(stale)).toEqual([]);
    expect(store.listStaleSending(stale)).toEqual([]);
  });

  it('releases a reviewed item to the human, receipt attached', () => {
    const { item } = store.propose({ ...PROPOSAL, approverPersonality: 'brand-editor' });
    const receipt = {
      verdict: 'fail' as const,
      reasons: "'SOC2 certified' is not in truth-pack.md",
      revision: 1,
      reviewedAt: Date.now(),
    };
    expect(store.attachReview(item.id, receipt)).toBe(true);
    const after = store.get(item.id);
    expect(after?.state).toBe('awaiting_approval');
    // A FAIL verdict still reaches the human — the reviewer is advisory (O-D4).
    expect(after?.review).toEqual(receipt);
    expect(store.attachReview(item.id, receipt)).toBe(false);
  });
});

describe('SQLiteOutboxStore — persistence', () => {
  it('keeps pending and approved rows across a reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ethos-outbox-'));
    const path = join(dir, 'outbox.db');
    let db = new SQLiteOutboxStore(path);
    let pendingId: string;
    let approvedId: string;
    try {
      pendingId = db.propose(PROPOSAL).item.id;
      const second = db.propose({ ...PROPOSAL, text: 'second post' }).item;
      approvedId = second.id;
      expect(db.approve(second.id, 1, second.contentHash, 'mitesh')).toBe(true);
    } finally {
      db.close();
    }
    db = new SQLiteOutboxStore(path);
    try {
      expect(db.get(pendingId)?.state).toBe('awaiting_approval');
      expect(db.get(approvedId)?.state).toBe('approved');
      expect(db.get(approvedId)?.approvedBy).toBe('mitesh');
      expect(db.getRevision(pendingId, 1)?.text).toBe(PROPOSAL.text);
      expect(db.listClaimable(['bot-marketing']).map((i) => i.id)).toEqual([approvedId]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Durability posture — see CLAUDE.md's SQLite store roster.
// ---------------------------------------------------------------------------

/** Reads `PRAGMA synchronous` off the store's OWN handle — it is a
 *  per-connection setting, so a second connection to the same file would
 *  report its own default and prove nothing. 2 = FULL (SQLite's default),
 *  1 = NORMAL. */
function syncPragma(s: unknown): number {
  const rows = (s as { db: { pragma(q: string): unknown } }).db.pragma('synchronous');
  return (rows as Array<{ synchronous: number }>)[0]?.synchronous ?? -1;
}

describe('SQLiteOutboxStore — durability posture', () => {
  it('stays at synchronous = FULL', () => {
    // NOT a candidate for `synchronous = NORMAL`, pinned here so a later
    // blanket sweep of the SQLite stores cannot take it silently.
    //
    // A queued publication is work owed to a person. Under NORMAL a power cut
    // can roll back the last commits — which is exactly the commit that
    // recorded a human pressing Approve. The publication then never goes out
    // and nothing anywhere says why, because the row still reads
    // `awaiting_approval` and the human remembers approving it. The write path
    // is a handful of commits per publication on a human's cadence, so the
    // fsync costs nothing that matters here.
    const s = new SQLiteOutboxStore(':memory:');
    // Asserted against the opened database, not the source text.
    expect(syncPragma(s)).toBe(2);
    s.close();
  });
});
