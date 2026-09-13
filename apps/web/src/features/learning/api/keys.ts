// Query keys for the learning inbox (plan `trust-before-reach.md` Part 4,
// L-T9).
//
// Everything hangs off one root, so a decision made on the Learning page
// invalidates `learningKeys.all()` and refreshes the sidebar count and the
// "N changes waiting" links on Living Soul and Skills in the same pass.

export interface LearningListScope {
  personalityId?: string;
  kind?: 'skill' | 'expression';
}

export const learningKeys = {
  all: () => ['learning'] as const,
  list: (scope: LearningListScope) => [...learningKeys.all(), 'list', scope] as const,
  get: (candidateId: string) => [...learningKeys.all(), 'get', candidateId] as const,
  /** Counts behind the sidebar badge and the links that replaced the old queues. */
  count: (scope: LearningListScope & { statuses: readonly string[] }) =>
    [...learningKeys.all(), 'count', scope] as const,
};
