// Plan personality-memory-boundary G2, D28 — the self-amendment store under
// `learning/amendments/`.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { AmendmentOp, AmendmentProvenance } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { opsHash } from '../amendment-ops';
import {
  type CreateAmendmentInput,
  checkPendingLimits,
  createAmendment,
  listAmendments,
  MAX_PENDING_AMENDMENTS,
  newAmendmentId,
  readAmendment,
  transitionAmendment,
} from '../amendment-store';
import { amendmentApplyLockPath, amendmentProposalPath, amendmentsDir } from '../paths';
import { sha256Hex } from '../store';

const DATA = '/ethos';

let storage: InMemoryStorage;
let clock: number;
const now = () => {
  clock += 1000;
  return clock;
};

beforeEach(() => {
  storage = new InMemoryStorage();
  clock = Date.parse('2026-09-28T00:00:00.000Z');
});

const provenance: AmendmentProvenance = {
  sessionId: 's1',
  sessionKey: 'cli:project',
  platform: 'cli',
  initiator: 'user',
  roomAudience: 'private',
  executionPosture: 'docker',
  holdsShellTool: false,
};

function input(over: Partial<CreateAmendmentInput> = {}): CreateAmendmentInput {
  return {
    personalityId: 'researcher',
    ops: [{ op: 'add_tool', tool: 'web_fetch' }],
    baseHash: sha256Hex('- read_file\n'),
    rationale: 'web_fetch was refused twice',
    evidence: [],
    provenance,
    preCheck: 'ok',
    status: 'pending',
    ...over,
  };
}

async function created(over: Partial<CreateAmendmentInput> = {}) {
  const result = await createAmendment(storage, DATA, input(over), now);
  if (result.kind !== 'created') throw new Error(`expected created, got ${result.kind}`);
  return result.record;
}

describe('amendment round trip', () => {
  it('writes proposal.json under learning/amendments/<id>/ with canonical ops and a filed entry', async () => {
    const record = await created({
      ops: [
        { op: 'remove_tool', tool: 'web_search' },
        { op: 'add_tool', tool: 'web_fetch' },
        { op: 'add_tool', tool: 'web_fetch' },
      ],
    });
    expect(record.id).toMatch(/^a-[0-9a-z]+-[0-9a-z]+$/);
    expect(amendmentProposalPath(DATA, record.id)).toBe(
      `/ethos/learning/amendments/${record.id}/proposal.json`,
    );
    const ops: AmendmentOp[] = [
      { op: 'add_tool', tool: 'web_fetch' },
      { op: 'remove_tool', tool: 'web_search' },
    ];
    expect(record).toMatchObject({
      schemaVersion: 1,
      personalityId: 'researcher',
      target: 'toolset',
      ops,
      opsHash: opsHash(ops),
      status: 'pending',
      preCheck: 'ok',
      history: [{ action: 'filed', actor: 'intake' }],
    });
    expect(await readAmendment(storage, DATA, record.id)).toEqual(record);
    expect(await listAmendments(storage, DATA)).toEqual([record]);
  });

  it('records an auto-rejection with the constitution reason, outside the pending count', async () => {
    const record = await created({ status: 'auto_rejected', preCheck: { reason: 'no terminal' } });
    expect(record.status).toBe('auto_rejected');
    expect(record.history).toEqual([
      expect.objectContaining({ action: 'auto_reject', reason: 'no terminal' }),
    ]);
    expect(await checkPendingLimits(storage, DATA, 'researcher', record.opsHash)).toEqual({
      kind: 'ok',
    });
  });

  it('lists newest first, filters, and skips the lock file and unreadable records', async () => {
    const a = await created({ personalityId: 'researcher' });
    const b = await created({ personalityId: 'writer' });
    await storage.write(amendmentApplyLockPath(DATA), '{"pid":1}');
    await storage.mkdir(`${amendmentsDir(DATA)}/a-broken-1`);
    await storage.write(`${amendmentsDir(DATA)}/a-broken-1/proposal.json`, '{not json');
    expect((await listAmendments(storage, DATA)).map((r) => r.id)).toEqual([b.id, a.id]);
    expect(
      (await listAmendments(storage, DATA, { personalityId: 'writer' })).map((r) => r.id),
    ).toEqual([b.id]);
    expect(await listAmendments(storage, DATA, { status: 'applied' })).toEqual([]);
  });

  it('reads a forged record with malformed ops as no record at all (C5)', async () => {
    const record = await created();
    const path = amendmentProposalPath(DATA, record.id);
    const stored = JSON.parse((await storage.read(path)) ?? '{}');
    const forgeries: unknown[] = [
      [{ op: 'grant_all', tool: 'terminal' }],
      [{ op: 'add_tool', tool: 42 }],
      [{ op: 'add_tool', tool: 'terminal\n- web_fetch' }],
      ['add_tool terminal'],
      [
        { op: 'add_tool', tool: 'terminal' },
        { op: 'remove_tool', tool: 'terminal' },
      ],
    ];
    for (const ops of forgeries) {
      await storage.write(path, JSON.stringify({ ...stored, ops }));
      expect(await readAmendment(storage, DATA, record.id)).toBeNull();
    }
    await storage.write(path, JSON.stringify({ ...stored, opsHash: undefined }));
    expect(await readAmendment(storage, DATA, record.id)).toBeNull();
  });

  // plan personality-presence-and-initiative §1 — identity records.
  it('stores an identity record with canonical ops and re-validates it on read', async () => {
    const record = await created({
      target: 'identity',
      baseHash: sha256Hex('name: nova\n'),
      ops: [
        { op: 'set_display_emoji', value: '🦉' },
        { op: 'set_name', value: ' Nova ' },
      ],
    });
    expect(record.target).toBe('identity');
    expect(record.ops).toEqual([
      { op: 'set_name', value: 'Nova' },
      { op: 'set_display_emoji', value: '🦉' },
    ]);
    expect(await readAmendment(storage, DATA, record.id)).toEqual(record);

    const path = amendmentProposalPath(DATA, record.id);
    const stored = JSON.parse((await storage.read(path)) ?? '{}');
    const forgeries: unknown[] = [
      [{ op: 'set_display_emoji', value: 'owl' }],
      [{ op: 'set_display_avatar', value: 'https://evil.example/a.png' }],
      [{ op: 'set_name', value: 'A\nfs_reach.write: /' }],
      [{ op: 'add_tool', tool: 'terminal' }],
      [{ op: 'set_toolset', value: 'terminal' }],
    ];
    for (const ops of forgeries) {
      await storage.write(path, JSON.stringify({ ...stored, ops }));
      expect(await readAmendment(storage, DATA, record.id)).toBeNull();
    }
    // A toolset record carrying identity ops is refused the same way.
    await storage.write(
      path,
      JSON.stringify({ ...stored, target: 'toolset', ops: [{ op: 'set_name', value: 'X' }] }),
    );
    expect(await readAmendment(storage, DATA, record.id)).toBeNull();
    await storage.write(path, JSON.stringify({ ...stored, target: 'soul' }));
    expect(await readAmendment(storage, DATA, record.id)).toBeNull();
  });

  it('returns an empty list when the directory does not exist', async () => {
    expect(await listAmendments(storage, DATA)).toEqual([]);
  });

  it('refuses input no filing path should produce', async () => {
    await expect(
      createAmendment(
        storage,
        DATA,
        input({
          ops: [
            { op: 'add_tool', tool: 'x' },
            { op: 'remove_tool', tool: 'x' },
          ],
        }),
        now,
      ),
    ).rejects.toThrow(/conflict/);
    await expect(
      createAmendment(storage, DATA, input({ rationale: 'x'.repeat(1001) }), now),
    ).rejects.toThrow(/rationale/);
    await expect(
      createAmendment(storage, DATA, input({ preCheck: { reason: 'r' } }), now),
    ).rejects.toThrow(/pre-check/);
    const record = await created({ id: 'a-fixed-1' });
    await expect(
      createAmendment(
        storage,
        DATA,
        input({ id: record.id, ops: [{ op: 'add_tool', tool: 'other' }] }),
        now,
      ),
    ).rejects.toThrow(/already exists/);
  });

  it('newAmendmentId is sortable by time', () => {
    expect(newAmendmentId(() => 1) < newAmendmentId(() => 2 ** 40)).toBe(true);
  });
});

describe('limits and dedupe', () => {
  it('returns the existing pending id for the same canonical ops', async () => {
    const first = await created();
    const again = await createAmendment(
      storage,
      DATA,
      input({
        ops: [
          { op: 'add_tool', tool: 'web_fetch' },
          { op: 'add_tool', tool: 'web_fetch' },
        ],
        rationale: 'different words',
      }),
      now,
    );
    expect(again).toEqual({ kind: 'duplicate', record: first });
    expect(await listAmendments(storage, DATA)).toHaveLength(1);
  });

  it(`allows at most ${MAX_PENDING_AMENDMENTS} pending per personality`, async () => {
    for (let i = 0; i < MAX_PENDING_AMENDMENTS; i++) {
      await created({ ops: [{ op: 'add_tool', tool: `tool_${i}` }] });
    }
    const over = await createAmendment(
      storage,
      DATA,
      input({ ops: [{ op: 'add_tool', tool: 'one_more' }] }),
      now,
    );
    expect(over).toEqual({ kind: 'limit', pending: MAX_PENDING_AMENDMENTS });
    // Another personality is unaffected; a duplicate at the limit still answers with its id.
    await created({ personalityId: 'writer', ops: [{ op: 'add_tool', tool: 'one_more' }] });
    const dup = await checkPendingLimits(
      storage,
      DATA,
      'researcher',
      opsHash([{ op: 'add_tool', tool: 'tool_0' }]),
    );
    expect(dup.kind).toBe('duplicate');
  });

  it('a decided amendment no longer counts or dedupes', async () => {
    const first = await created();
    await transitionAmendment(
      storage,
      DATA,
      first.id,
      { to: 'declined', actor: 'cli', decidedBy: 'owner', reason: 'not now' },
      now,
    );
    const again = await createAmendment(storage, DATA, input(), now);
    expect(again.kind).toBe('created');
  });
});

describe('transitions (decision history on the record, D29)', () => {
  it('pending → applied → rolled_back appends history and records the applied hash', async () => {
    const record = await created();
    const applied = await transitionAmendment(
      storage,
      DATA,
      record.id,
      { to: 'applied', actor: 'cli', decidedBy: 'owner', appliedHash: 'h1' },
      now,
    );
    expect(applied.status).toBe('applied');
    expect(applied.applied).toEqual({ appliedHash: 'h1', at: applied.updatedAt });
    const rolled = await transitionAmendment(
      storage,
      DATA,
      record.id,
      { to: 'rolled_back', actor: 'cli', decidedBy: 'owner' },
      now,
    );
    expect(rolled.history.map((h) => [h.action, h.actor, h.decidedBy])).toEqual([
      ['filed', 'intake', undefined],
      ['approve', 'cli', 'owner'],
      ['rollback', 'cli', 'owner'],
    ]);
    expect(await readAmendment(storage, DATA, record.id)).toEqual(rolled);
  });

  it('stale → declined is how an owner closes a stale proposal', async () => {
    const record = await created();
    await transitionAmendment(storage, DATA, record.id, { to: 'stale', actor: 'cli' }, now);
    const declined = await transitionAmendment(
      storage,
      DATA,
      record.id,
      { to: 'declined', actor: 'cli', decidedBy: 'owner' },
      now,
    );
    expect(declined.status).toBe('declined');
  });

  it('stale → applied is allowed (crash recovery completes an apply that already wrote)', async () => {
    const record = await created();
    await transitionAmendment(storage, DATA, record.id, { to: 'stale', actor: 'cli' }, now);
    const applied = await transitionAmendment(
      storage,
      DATA,
      record.id,
      { to: 'applied', actor: 'cli', decidedBy: 'owner', appliedHash: 'h' },
      now,
    );
    expect(applied).toMatchObject({ status: 'applied', applied: { appliedHash: 'h' } });
  });

  it('refuses transitions out of a terminal status, applied without a hash, and a missing record', async () => {
    const record = await created();
    await expect(
      transitionAmendment(storage, DATA, record.id, { to: 'applied', actor: 'cli' }, now),
    ).rejects.toThrow(/appliedHash/);
    await expect(
      transitionAmendment(storage, DATA, record.id, { to: 'rolled_back', actor: 'cli' }, now),
    ).rejects.toThrow(/cannot go from pending to rolled_back/);
    await transitionAmendment(storage, DATA, record.id, { to: 'declined', actor: 'cli' }, now);
    await expect(
      transitionAmendment(
        storage,
        DATA,
        record.id,
        { to: 'applied', actor: 'cli', appliedHash: 'h' },
        now,
      ),
    ).rejects.toThrow(/cannot go from declined/);
    await expect(
      transitionAmendment(storage, DATA, 'a-missing-1', { to: 'declined', actor: 'cli' }, now),
    ).rejects.toThrow(/No such amendment/);
  });

  it('refuses a path-unsafe id', async () => {
    await expect(readAmendment(storage, DATA, '../candidates/x')).rejects.toThrow();
  });
});
