import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type OutboxStore, SQLiteOutboxStore } from '@ethosagent/outbox';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboxService } from '../../services/outbox.service';

// O-T9 — the web half of the personality approval outbox.
//
// The lifecycle itself is covered in `extensions/outbox/src/__tests__`; what is
// under test here is the SERVICE boundary: that a bound approve carrying a
// stale revision or hash is refused as `conflict` (which `rpc/outbox.ts` maps
// to CONFLICT), that a listing narrows by personality and by team, and that the
// borrowed store is opened lazily and closed once.

const DECIDER = 'tab-A';

describe('OutboxService', () => {
  let dir: string;
  let store: OutboxStore;
  let service: OutboxService;
  let teamMembers: (teamId: string) => Promise<readonly string[]>;
  const teamCalls: string[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-outbox-'));
    // The file must EXIST for the service to open anything (see `open`), but the
    // handle it gets is an in-memory store — the same `openStore` seam the other
    // read-side services take.
    await new FsStorage().write(join(dir, 'outbox.db'), 'x');
    store = new SQLiteOutboxStore(':memory:');
    teamCalls.length = 0;
    teamMembers = async (teamId: string) => {
      teamCalls.push(teamId);
      return ['coordinator', 'scout'];
    };
    service = new OutboxService({
      dataDir: dir,
      storage: new FsStorage(),
      openStore: () => store,
      teamMembers: (teamId) => teamMembers(teamId),
    });
  });

  afterEach(async () => {
    service.close();
    await rm(dir, { recursive: true, force: true });
  });

  function propose(overrides: Partial<Parameters<OutboxStore['propose']>[0]> = {}) {
    return store.propose({
      personalityId: 'coordinator',
      botKey: 'bot-a',
      platform: 'telegram',
      chatId: '-100',
      text: 'Ethos 0.9 is out.',
      ...overrides,
    });
  }

  // -- the binding ----------------------------------------------------------

  it('approves a revision the human actually read', async () => {
    const { item } = propose();
    const result = await service.approve({
      itemId: item.id,
      revision: item.revision,
      contentHash: item.contentHash,
      decidedBy: DECIDER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('approved');
    expect(result.value.approvedBy).toBe(DECIDER);
    expect(result.value.approvedRevision).toBe(1);
    // The exact bytes travel back, untruncated — the card shows what will be sent.
    expect(result.value.text).toBe('Ethos 0.9 is out.');
  });

  it('refuses an approve carrying an outdated contentHash → conflict', async () => {
    const { item } = propose();
    const result = await service.approve({
      itemId: item.id,
      revision: item.revision,
      contentHash: 'f'.repeat(64),
      decidedBy: DECIDER,
    });
    expect(result).toEqual({ ok: false, code: 'conflict', error: 'changed since you viewed it' });
    expect(store.get(item.id)?.state).toBe('awaiting_approval');
  });

  it('refuses an approve carrying an outdated revision → conflict', async () => {
    const { item } = propose();
    // The realistic shape of "outdated": someone edited the text while the card
    // was on screen, so revision 1 and its hash are both stale.
    const edited = store.edit(item.id, 1, 'Ethos 0.9 ships Friday.', 'tab-B');
    expect(edited?.revision).toBe(2);
    const result = await service.approve({
      itemId: item.id,
      revision: 1,
      contentHash: item.contentHash,
      decidedBy: DECIDER,
    });
    expect(result).toEqual({ ok: false, code: 'conflict', error: 'changed since you viewed it' });
    expect(store.get(item.id)?.state).toBe('awaiting_approval');
    expect(store.get(item.id)?.approvedBy).toBeUndefined();
  });

  it('refuses an approve whose revision is stale even when the hash is current', async () => {
    const { item } = propose();
    const edited = store.edit(item.id, 1, 'Ethos 0.9 ships Friday.', 'tab-B');
    const current = edited?.contentHash ?? '';
    const result = await service.approve({
      itemId: item.id,
      revision: 1,
      contentHash: current,
      decidedBy: DECIDER,
    });
    expect(result).toEqual({ ok: false, code: 'conflict', error: 'changed since you viewed it' });
  });

  it('distinguishes a move that was never available from a stale one', async () => {
    const { item } = propose();
    const result = await service.revoke({ itemId: item.id, decidedBy: DECIDER });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Not `conflict`: nothing moved underneath the caller, the button should not
    // have rendered for an item nobody has approved yet.
    expect(result.code).toBe('illegal_transition');
  });

  it('answers not_found for an unknown item, and for a deployment with no store', async () => {
    expect(await service.reject({ itemId: 'obx_nope', reason: 'no', decidedBy: DECIDER })).toEqual({
      ok: false,
      code: 'not_found',
      error: 'no outbox item obx_nope',
    });

    const empty = new OutboxService({
      dataDir: join(dir, 'nothing-here'),
      storage: new FsStorage(),
      openStore: () => {
        throw new Error('must not open a store that does not exist');
      },
      teamMembers: async () => [],
    });
    expect(await empty.list()).toEqual({ items: [] });
    const decided = await empty.approve({
      itemId: 'obx_1',
      revision: 1,
      contentHash: 'x',
      decidedBy: DECIDER,
    });
    expect(decided).toEqual({ ok: false, code: 'not_found', error: 'no outbox item obx_1' });
  });

  // -- the other decisions --------------------------------------------------

  it('edit bumps the revision and voids the approval; reject and retry round-trip', async () => {
    const { item } = propose();
    await service.approve({
      itemId: item.id,
      revision: 1,
      contentHash: item.contentHash,
      decidedBy: DECIDER,
    });
    // An approved item cannot be edited — the human revokes first.
    const revoked = await service.revoke({ itemId: item.id, decidedBy: DECIDER });
    expect(revoked.ok && revoked.value.state).toBe('awaiting_approval');

    const edited = await service.edit({
      itemId: item.id,
      revision: 1,
      text: 'Ethos 0.9 ships Friday.',
      decidedBy: DECIDER,
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.revision).toBe(2);
    expect(edited.value.text).toBe('Ethos 0.9 ships Friday.');
    expect(edited.value.contentHash).not.toBe(item.contentHash);
    expect(edited.value.approvedBy).toBeNull();

    const got = await service.get(item.id);
    expect(got.ok && got.value.revisions.map((r) => r.revision)).toEqual([1, 2]);

    const rejected = await service.reject({
      itemId: item.id,
      reason: 'off-message',
      decidedBy: DECIDER,
    });
    expect(rejected.ok && rejected.value.state).toBe('rejected');
    expect(rejected.ok && rejected.value.rejectionReason).toBe('off-message');
  });

  it('retry re-approves a failed item at the same revision', async () => {
    const { item } = propose();
    await service.approve({
      itemId: item.id,
      revision: 1,
      contentHash: item.contentHash,
      decidedBy: DECIDER,
    });
    store.claim(item.id);
    store.markFailed(item.id, 'interrupted before the platform call');
    const retried = await service.retry({ itemId: item.id, decidedBy: DECIDER });
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.state).toBe('approved');
    expect(retried.value.revision).toBe(1);
  });

  // -- listing --------------------------------------------------------------

  it('list filters by personality', async () => {
    propose({ personalityId: 'coordinator', text: 'one' });
    propose({ personalityId: 'scout', text: 'two' });
    propose({ personalityId: 'unrelated', text: 'three' });

    const all = await service.list();
    expect(all.items).toHaveLength(3);

    const coordinator = await service.list({ personalityId: 'coordinator' });
    expect(coordinator.items.map((i) => i.personalityId)).toEqual(['coordinator']);
    expect(coordinator.items[0]?.text).toBe('one');
  });

  it('list filters by team, expanding it to the team roster', async () => {
    propose({ personalityId: 'coordinator', text: 'one' });
    propose({ personalityId: 'scout', text: 'two' });
    propose({ personalityId: 'unrelated', text: 'three' });

    const team = await service.list({ teamId: 'alpha' });
    expect(teamCalls).toEqual(['alpha']);
    expect(team.items.map((i) => i.personalityId).sort()).toEqual(['coordinator', 'scout']);
  });

  it('list given both filters takes the intersection', async () => {
    propose({ personalityId: 'coordinator', text: 'one' });
    propose({ personalityId: 'unrelated', text: 'three' });

    const inTeam = await service.list({ teamId: 'alpha', personalityId: 'coordinator' });
    expect(inTeam.items.map((i) => i.personalityId)).toEqual(['coordinator']);

    const notInTeam = await service.list({ teamId: 'alpha', personalityId: 'unrelated' });
    expect(notInTeam.items).toEqual([]);
  });

  it('list filters by state, and honours the limit after re-ordering', async () => {
    const a = propose({ text: 'one' });
    propose({ text: 'two' });
    await service.approve({
      itemId: a.item.id,
      revision: 1,
      contentHash: a.item.contentHash,
      decidedBy: DECIDER,
    });

    const awaiting = await service.list({ states: ['awaiting_approval'] });
    expect(awaiting.items.map((i) => i.text)).toEqual(['two']);

    const capped = await service.list({ teamId: 'alpha', limit: 1 });
    expect(capped.items).toHaveLength(1);
  });

  // -- the borrowed handle --------------------------------------------------

  it('opens nothing until asked, and closes once', async () => {
    const close = vi.fn();
    const lazy = new OutboxService({
      dataDir: dir,
      storage: new FsStorage(),
      openStore: () => ({ close, listByState: () => [] }) as unknown as OutboxStore,
      teamMembers: async () => [],
    });
    lazy.close();
    expect(close).not.toHaveBeenCalled();

    await lazy.list();
    lazy.close();
    expect(close).toHaveBeenCalledTimes(1);
    lazy.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
