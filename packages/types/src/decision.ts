// The decision provider contract (ARCHITECTURE.md §IV "Decision Provider
// Authoring", §VII roster; plan decision-provider-jev §4, D4). A decision
// provider answers typed questions about a piece of state and returns typed
// values with probabilities, never text. Frozen at one method: the gate is
// `__tests__/decision-provider-method-count.test.ts`, cross-checked against
// ARCHITECTURE.md `frozen_schemas.decision_provider`. `validateDecisionRequest`,
// which enforces `DECISION_LIMITS`, lives in `extensions/decision-typesafe/`
// until a second provider exists.

import type { AgentEvent } from './agent-event';

export const DECISION_LIMITS = {
  choiceMaxOptions: 255,
  scoreMinLevels: 2,
  scoreMaxLevels: 10,
} as const;

export type DecisionQuestion =
  | { type: 'boolean'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> } // option → description
  | { type: 'score'; instructions: string; criteria: string[] }; // ordered level descriptions

export interface DecisionRequest {
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, DecisionQuestion>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type DecisionAnswer =
  | { type: 'boolean'; p: number; confidence: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; level: number; score: number; probabilities: number[]; confidence: number };

export type DecisionErrorCode =
  | 'auth'
  | 'invalid'
  | 'rate_limited'
  | 'overloaded'
  | 'timeout'
  | 'aborted'
  | 'malformed'
  | 'too_large'
  | 'unavailable'
  /**
   * PD19 (plan decision-provider-personality §15.1): the provider's breaker is
   * open, so no request was sent. Distinct from `unavailable` so a surface can
   * say "skipped" rather than "failed". A breaker never counts it as a failure.
   */
  | 'breaker_open';

export type DecisionResult =
  | {
      ok: true;
      answers: Record<string, DecisionAnswer>;
      model: string;
      usage: { inputTokens: number; outputTokens: number };
    }
  | { ok: false; code: DecisionErrorCode; message: string };

export interface DecisionProvider {
  readonly name: string;
  readonly calibrated: boolean;
  decide(request: DecisionRequest): Promise<DecisionResult>;
}

/**
 * Where a decision site reports that it ran, for the turn's event stream (plan
 * decision-provider-personality §15.3, PD16). Core builds one per call and
 * passes it to the seam (the tier router input, the `InjectionClassifier`
 * input, the `before_tool_call` payload); the site calls `emit` from
 * `runDecisionSite` (packages/wiring/src/decision-site.ts). Core stamps the
 * fields it already holds — `personalityId`, `toolCallId`, `traceId` — so a
 * site cannot misattribute a row. `emit` never throws.
 */
export interface DecisionSink {
  /** The turn's observability trace, copied onto the site's record. */
  traceId?: string;
  emit(
    event: Omit<
      Extract<AgentEvent, { type: 'decision' }>,
      'type' | 'personalityId' | 'toolCallId' | 'traceId'
    >,
  ): void;
}
