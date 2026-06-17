import { os } from './context';

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
  applyExpression: os.personalities.applyExpression.handler(({ input, context }) =>
    context.personalities.applyExpression(
      input.id,
      input.newExpression,
      input.summary,
      input.evidenceRef,
    ),
  ),
  revertExpression: os.personalities.revertExpression.handler(({ input, context }) =>
    context.personalities.revertExpression(input.id),
  ),
  proposeSoulSplit: os.personalities.proposeSoulSplit.handler(({ input, context }) =>
    context.personalities.proposeSoulSplit(input.soulMd),
  ),
};
