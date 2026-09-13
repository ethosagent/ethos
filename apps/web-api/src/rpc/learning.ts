import { ORPCError } from '@orpc/server';
import type { LearningRefusalCode, LearningServiceResult } from '../services/learning.service';
import { os } from './context';

// Learning namespace — the web review inbox for replay-gated learning (plan
// `trust-before-reach.md` Part 4, L-T8).
//
// Thin by construction. Every procedure marshals input into `LearningService`
// and maps one refusal; the override rule, promotion, rollback and the audit
// rows live in `LearningInbox` (`extensions/learning-inbox/src/inbox.ts`).
//
// Auth: the `/rpc` cookie gate. `learning` is not in `SCOPE_MAP`, so a bearer
// API key fails closed here (`middleware/dual-auth.ts`). `clientId` travels in
// as `decidedBy` for the audit trail — a label, never the gate.

/**
 * HTTP status per refusal. A `Record` over the refusal union, so a refusal
 * the inbox gains and this table does not fails to typecheck instead of
 * falling through as a 500.
 *
 * `override_required` is 400: the request is missing the reason it needs.
 * The 409s are all "not from this state" — including `live_edited` ("the live
 * file has been edited since") and `stale`, which the UI shows rather than
 * retries.
 */
const STATUS: Record<LearningRefusalCode, number> = {
  not_found: 404,
  override_required: 400,
  invalid: 422,
  stale: 409,
  not_promotable: 409,
  not_promoted: 409,
  no_record: 409,
  live_edited: 409,
  not_latest: 409,
  not_rejectable: 409,
  not_replayable: 409,
  ambiguous: 409,
  replay_failed: 502,
  replay_unavailable: 503,
};

/**
 * A learning refusal as a typed oRPC error: `override_required` →
 * `OVERRIDE_REQUIRED`, and so on — the code IS the contract with the UI.
 * Exported for `personalities.applyExpression` (`rpc/personalities-learning.ts`),
 * which decides through the same inbox and so answers with the same codes.
 * `action`, when given, rides in `data.action` — the slot `routes/rpc.ts` gives
 * an `EthosError`'s action.
 */
export function learningRpcError(
  refusal: { code: LearningRefusalCode; reason: string },
  action?: string,
) {
  return new ORPCError(refusal.code.toUpperCase(), {
    status: STATUS[refusal.code],
    message: refusal.reason,
    ...(action ? { data: { action } } : {}),
  });
}

function unwrap<T>(result: LearningServiceResult<T>): T {
  if (result.ok) return result.value;
  throw learningRpcError(result);
}

export const learningRouter = {
  list: os.learning.list.handler(({ input, context }) => context.learning.list(input)),

  get: os.learning.get.handler(async ({ input, context }) =>
    unwrap(await context.learning.get(input.candidateId)),
  ),

  replay: os.learning.replay.handler(async ({ input, context }) =>
    unwrap(await context.learning.replay(input.candidateId)),
  ),

  approve: os.learning.approve.handler(async ({ input, context }) => ({
    candidate: unwrap(
      await context.learning.approve({
        candidateId: input.candidateId,
        decidedBy: input.clientId,
        override: input.override,
      }),
    ).candidate,
  })),

  reject: os.learning.reject.handler(async ({ input, context }) =>
    unwrap(
      await context.learning.reject({
        candidateId: input.candidateId,
        decidedBy: input.clientId,
        reason: input.reason,
      }),
    ),
  ),

  rollback: os.learning.rollback.handler(async ({ input, context }) =>
    unwrap(
      await context.learning.rollback({
        candidateId: input.candidateId,
        decidedBy: input.clientId,
        reason: input.reason,
      }),
    ),
  ),
};
