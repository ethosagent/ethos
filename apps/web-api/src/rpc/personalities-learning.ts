import { os } from './context';
import { learningRpcError } from './learning';

// Governed-learning procedures for a personality's Living Soul Expression
// (Phase 3a). Split out of `personalities.ts` to keep each handler file thin.
// Spread into `personalitiesRouter`.

export const personalitiesLearningRouter = {
  livingSoul: os.personalities.livingSoul.handler(({ input, context }) =>
    context.personalities.livingSoul(input.id),
  ),
  proposeExpression: os.personalities.proposeExpression.handler(({ input, context }) =>
    context.personalities.proposeExpression(input.id),
  ),
  applyExpression: os.personalities.applyExpression.handler(async ({ input, context }) => {
    const result = await context.personalities.applyExpression(
      input.id,
      input.newExpression,
      input.summary,
      input.evidenceRef,
      input.overrideReason,
    );
    // The same refusal table `learning.approve` answers with, so the Living
    // Soul UI can tell `STALE` from `OVERRIDE_REQUIRED`.
    if (!result.ok) throw learningRpcError(result, result.action);
    return result.value;
  }),
  revertExpression: os.personalities.revertExpression.handler(({ input, context }) =>
    context.personalities.revertExpression(input.id),
  ),
  proposeSoulSplit: os.personalities.proposeSoulSplit.handler(({ input, context }) =>
    context.personalities.proposeSoulSplit(input.soulMd),
  ),
};
