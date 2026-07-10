import { llmJudgeScorer } from '@ethosagent/eval-harness';
import type {
  BeforeTicketCompletePayload,
  BeforeTicketCompleteResult,
  LLMProvider,
} from '@ethosagent/types';

// Longest slice of the acceptance criteria echoed into a rejection reason —
// keeps the audit trail readable when criteria are long documents.
const MAX_CRITERIA_IN_REASON = 300;

export interface CompletionVerifierOptions {
  /** Lazy provider so wiring can defer construction until the first completion. */
  getProvider: () => Promise<LLMProvider>;
}

/**
 * Phase 7 — independent scoring pass gating the running → done transition.
 *
 * Returns a `before_ticket_complete` claiming handler that runs the
 * eval-harness LLM judge over the completion summary against the ticket's
 * acceptance criteria. `handled: true` rejects the completion (the ticket
 * moves to `needs_revision`); `handled: false` lets it proceed to `done`.
 */
export function createCompletionVerifier(
  opts: CompletionVerifierOptions,
): (payload: BeforeTicketCompletePayload) => Promise<BeforeTicketCompleteResult> {
  return async (payload) => {
    // No acceptance criteria → nothing to verify; completion proceeds. The
    // provider is never constructed on this path.
    if (payload.acceptanceCriteria === undefined) {
      return { handled: false };
    }

    // `payload.autonomyTier` is deliberately ignored — a `trusted` assignee is
    // still verified. Phase 7 requirement: the review state is non-skippable,
    // so reputation does not buy a way around the scoring pass.
    try {
      const provider = await opts.getProvider();
      const score = await llmJudgeScorer(provider)(payload.summary, {
        id: payload.taskId,
        expected: payload.acceptanceCriteria,
        match: 'llm',
      });
      // Score >= 1 → the judge verified the summary; completion proceeds.
      if (score >= 1) {
        return { handled: false };
      }
      // Score 0 → rejected. Include the criteria (truncated) so the
      // needs_revision audit trail says what the summary failed to satisfy.
      const criteria = payload.acceptanceCriteria.slice(0, MAX_CRITERIA_IN_REASON);
      return {
        handled: true,
        reason: `verifier: completion summary does not satisfy the acceptance criteria: ${criteria}`,
      };
    } catch (err) {
      // Fail CLOSED on verifier errors. fireClaiming swallows handler throws
      // (fail-open), so returning the rejection here is the only way to keep
      // the review state non-skippable when the verifier itself breaks.
      const message = err instanceof Error ? err.message : String(err);
      return { handled: true, reason: `verifier error (fail-closed): ${message}` };
    }
  };
}
