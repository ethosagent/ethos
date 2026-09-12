import { call, ORPCError } from '@orpc/server';
import { describe, expect, it } from 'vitest';
import type { RpcContext } from '../../rpc/context';
import { outboxRouter } from '../../rpc/outbox';
import type { OutboxService, OutboxServiceResult } from '../../services/outbox.service';

// O-T9 — the RPC shell. What it must get right is the ERROR MAPPING: a bound
// approve that no longer matches what the human read has to reach the UI as
// CONFLICT, so the pane re-reads instead of publishing text nobody approved.
// The service's own behaviour is covered in
// `__tests__/services/outbox.service.test.ts`.

const ITEM = {
  id: 'obx_1',
  personalityId: 'cmo',
  botKey: 'bot-a',
  platform: 'telegram',
  chatId: '-100',
  threadId: null,
  revision: 1,
  contentHash: 'a'.repeat(64),
  text: 'Ethos 0.9 is out.',
  state: 'awaiting_approval' as const,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
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
};

interface Recorded {
  approve: unknown[];
  list: unknown[];
}

function makeContext(overrides: Partial<OutboxService> = {}): {
  context: RpcContext;
  recorded: Recorded;
} {
  const recorded: Recorded = { approve: [], list: [] };
  const outbox = {
    list: async (input: unknown) => {
      recorded.list.push(input);
      return { items: [ITEM] };
    },
    get: async () => ({ ok: true as const, value: { item: ITEM, revisions: [] } }),
    approve: async (input: unknown) => {
      recorded.approve.push(input);
      return { ok: true as const, value: { ...ITEM, state: 'approved' as const } };
    },
    reject: async () => ({ ok: true as const, value: { ...ITEM, state: 'rejected' as const } }),
    edit: async () => ({ ok: true as const, value: { ...ITEM, revision: 2 } }),
    revoke: async () => ({ ok: true as const, value: ITEM }),
    retry: async () => ({ ok: true as const, value: { ...ITEM, state: 'approved' as const } }),
    ...overrides,
  };
  // Cast: the handlers touch `outbox` alone; the full RpcContext would drag in
  // every service for a unit-level test. Same shape as `rpc/a2a` tests.
  const context = { outbox } as unknown as RpcContext;
  return { context, recorded };
}

/** The failure codes the service can answer with, taken from its own result
 *  type rather than spelled again here. */
type OutboxFailureCode = Extract<OutboxServiceResult<never>, { ok: false }>['code'];

function failing(code: OutboxFailureCode, error: string) {
  return async () => ({ ok: false as const, code, error });
}

describe('outbox RPC', () => {
  it('approve forwards the binding and the decider, and returns the item', async () => {
    const { context, recorded } = makeContext();
    const res = await call(
      outboxRouter.approve,
      {
        itemId: 'obx_1',
        revision: 1,
        contentHash: 'a'.repeat(64),
        clientId: 'tab-A',
      },
      { context },
    );
    expect(res.item.state).toBe('approved');
    expect(recorded.approve).toEqual([
      { itemId: 'obx_1', revision: 1, contentHash: 'a'.repeat(64), decidedBy: 'tab-A' },
    ]);
  });

  it('an approve with an outdated hash or revision → CONFLICT (409)', async () => {
    const { context } = makeContext({
      approve: failing('conflict', 'changed since you viewed it'),
    });
    try {
      await call(
        outboxRouter.approve,
        { itemId: 'obx_1', revision: 1, contentHash: 'stale', clientId: 'tab-A' },
        { context },
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ORPCError);
      const orpc = err as ORPCError<string, unknown>;
      expect(orpc.code).toBe('CONFLICT');
      expect(orpc.status).toBe(409);
      expect(orpc.message).toBe('changed since you viewed it');
    }
  });

  it('an unknown item → NOT_FOUND (404)', async () => {
    const { context } = makeContext({ get: failing('not_found', 'no outbox item obx_9') });
    try {
      await call(outboxRouter.get, { itemId: 'obx_9' }, { context });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ORPCError<string, unknown>).code).toBe('NOT_FOUND');
      expect((err as ORPCError<string, unknown>).status).toBe(404);
    }
  });

  it('a move that was never available stays distinct from a stale one', async () => {
    const { context } = makeContext({
      revoke: failing('illegal_transition', 'cannot revoke an item in state sent (obx_1)'),
    });
    try {
      await call(outboxRouter.revoke, { itemId: 'obx_1', clientId: 'tab-A' }, { context });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ORPCError<string, unknown>).code).toBe('ILLEGAL_TRANSITION');
    }
  });

  it('list passes the pane filters straight through', async () => {
    const { context, recorded } = makeContext();
    const res = await call(
      outboxRouter.list,
      { teamId: 'marketing', states: ['awaiting_approval'], limit: 50 },
      { context },
    );
    expect(res.items).toHaveLength(1);
    expect(recorded.list).toEqual([
      { teamId: 'marketing', states: ['awaiting_approval'], limit: 50 },
    ]);
  });
});
