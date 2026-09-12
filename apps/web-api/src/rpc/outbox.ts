import { ORPCError } from '@orpc/server';
import type { OutboxServiceResult } from '../services/outbox.service';
import { os } from './context';

// Outbox namespace — the web approval surface for the personality approval
// queue (plan `trust-before-reach.md` Part 2, O-T9).
//
// Thin by construction. Every procedure marshals input into `OutboxService` and
// maps one failure code; the lifecycle, the conditional UPDATEs and the audit
// rows live in `@ethosagent/outbox`, and the state machine is NOT repeated here.
//
// Auth (O-D5): the `/rpc` cookie/bearer gate alone. Any authenticated session
// counts as the operator on the web, the same rule `deliveries` rides on — no
// `requireAdmin`, which belongs to the opt-in admin PANEL and would 403 this
// pane on every deployment that never enabled it. `clientId` travels in as
// `decidedBy` for the audit trail; it is a label, never the gate.
//
// There is NO send, claim or deliver procedure, and there never will be: this
// process holds no channel adapters. Approving writes a row and returns; the
// gateway dispatcher does the publishing.

/**
 * Map a service failure onto a typed oRPC error.
 *
 * `conflict` → `CONFLICT` (409) is the one that carries weight: it is what a
 * bound approve gets when the item was edited, revoked, rejected or expired
 * between the render and the click, and the message is the contract with the
 * UI ("changed since you viewed it" — re-read, do not publish).
 *
 * `illegal_transition` stays distinct on purpose. Collapsing it into `CONFLICT`
 * would tell a human "changed since you viewed it" about a button that should
 * never have rendered for that state.
 */
function unwrap<T>(result: OutboxServiceResult<T>): T {
  if (result.ok) return result.value;
  switch (result.code) {
    case 'not_found':
      throw new ORPCError('NOT_FOUND', { status: 404, message: result.error });
    case 'conflict':
      throw new ORPCError('CONFLICT', { status: 409, message: result.error });
    case 'illegal_transition':
      throw new ORPCError('ILLEGAL_TRANSITION', { status: 409, message: result.error });
    default:
      // `binding_mismatch` is raised by `verifyBinding`, which only the gateway
      // dispatcher calls. Mapped anyway so the switch is total and a future
      // reachable path cannot fall through as a 500.
      throw new ORPCError('BINDING_MISMATCH', { status: 409, message: result.error });
  }
}

export const outboxRouter = {
  list: os.outbox.list.handler(({ input, context }) => context.outbox.list(input)),

  get: os.outbox.get.handler(async ({ input, context }) =>
    unwrap(await context.outbox.get(input.itemId)),
  ),

  approve: os.outbox.approve.handler(async ({ input, context }) => ({
    item: unwrap(
      await context.outbox.approve({
        itemId: input.itemId,
        revision: input.revision,
        contentHash: input.contentHash,
        decidedBy: input.clientId,
      }),
    ),
  })),

  reject: os.outbox.reject.handler(async ({ input, context }) => ({
    item: unwrap(
      await context.outbox.reject({
        itemId: input.itemId,
        reason: input.reason,
        decidedBy: input.clientId,
      }),
    ),
  })),

  edit: os.outbox.edit.handler(async ({ input, context }) => ({
    item: unwrap(
      await context.outbox.edit({
        itemId: input.itemId,
        revision: input.revision,
        text: input.text,
        decidedBy: input.clientId,
      }),
    ),
  })),

  revoke: os.outbox.revoke.handler(async ({ input, context }) => ({
    item: unwrap(await context.outbox.revoke({ itemId: input.itemId, decidedBy: input.clientId })),
  })),

  retry: os.outbox.retry.handler(async ({ input, context }) => ({
    item: unwrap(await context.outbox.retry({ itemId: input.itemId, decidedBy: input.clientId })),
  })),
};
