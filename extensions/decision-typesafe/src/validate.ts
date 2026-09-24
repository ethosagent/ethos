// `validateDecisionRequest` — what a legal DecisionRequest is (plan §4, D4).
//
// Pure. Lives here, beside its only provider, until a second provider exists;
// then it moves out so the two cannot drift on what a legal request is (§16).
// The adapter calls it before any other work (`createTypesafeDecisionProvider`
// in ./provider), so a refused request never reaches the network — pinned by
// `__tests__/limits.test.ts`.

import { DECISION_LIMITS, type DecisionRequest } from '@ethosagent/types';

export type DecisionValidation = { ok: true } | { ok: false; code: 'invalid'; message: string };

function invalid(message: string): DecisionValidation {
  return { ok: false, code: 'invalid', message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateDecisionRequest(request: DecisionRequest): DecisionValidation {
  const { state, questions, timeoutMs } = request;
  if (typeof state !== 'string' && !isRecord(state) && !Array.isArray(state)) {
    return invalid('state must be a string, an object or an array');
  }
  if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    return invalid('timeoutMs must be a positive finite number');
  }
  if (!isRecord(questions) || Object.keys(questions).length === 0) {
    return invalid('questions must be a non-empty map');
  }
  for (const [id, question] of Object.entries(questions)) {
    if (!isRecord(question)) return invalid(`question "${id}" must be an object`);
    if (typeof question.instructions !== 'string' || question.instructions.trim() === '') {
      return invalid(`question "${id}" has empty instructions`);
    }
    switch (question.type) {
      case 'boolean': {
        const c = question.criteria;
        if (c !== undefined && (typeof c.true !== 'string' || typeof c.false !== 'string')) {
          return invalid(`question "${id}": boolean criteria needs string "true" and "false"`);
        }
        break;
      }
      case 'choice': {
        if (!isRecord(question.criteria)) {
          return invalid(`question "${id}": choice criteria must be an option map`);
        }
        const n = Object.keys(question.criteria).length;
        if (n < 1 || n > DECISION_LIMITS.choiceMaxOptions) {
          return invalid(
            `question "${id}": choice needs 1–${DECISION_LIMITS.choiceMaxOptions} options, got ${n}`,
          );
        }
        break;
      }
      case 'score': {
        if (!Array.isArray(question.criteria)) {
          return invalid(`question "${id}": score criteria must be an array of levels`);
        }
        const n = question.criteria.length;
        if (n < DECISION_LIMITS.scoreMinLevels || n > DECISION_LIMITS.scoreMaxLevels) {
          return invalid(
            `question "${id}": score needs ${DECISION_LIMITS.scoreMinLevels}–` +
              `${DECISION_LIMITS.scoreMaxLevels} levels, got ${n}`,
          );
        }
        break;
      }
      default:
        return invalid(`question "${id}" has unknown type`);
    }
  }
  return { ok: true };
}
