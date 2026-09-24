// The decision provider contract (ARCHITECTURE.md §IV "Decision Provider
// Authoring", §VII roster; plan decision-provider-jev §4, D4). A decision
// provider answers typed questions about a piece of state and returns typed
// values with probabilities, never text. Frozen at one method: the gate is
// `__tests__/decision-provider-method-count.test.ts`, cross-checked against
// ARCHITECTURE.md `frozen_schemas.decision_provider`. `validateDecisionRequest`,
// which enforces `DECISION_LIMITS`, lives in `extensions/decision-typesafe/`
// until a second provider exists.

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
  | 'unavailable';

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
