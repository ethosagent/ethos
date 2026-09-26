// Pre-network size refusal (plan §5.3, D9).
//
// A guard, not the arbiter: the estimate is `estimateTokens` from
// @ethosagent/core (packages/core/src/context-engines/token-estimator.ts,
// chars / 4), and a vendor 422 on a request this passed still maps to
// `invalid` in ./transport. Pinned by `__tests__/limits.test.ts`.

import { estimateTokens } from '@ethosagent/core';
import type { DecisionRequest } from '@ethosagent/types';

export const MAX_TOKENS_STATE_PLUS_LONGEST_QUESTION = 32_000;
export const MAX_TOKENS_STATE_PLUS_ALL_QUESTIONS = 64_000;

export function checkSize(
  request: DecisionRequest,
): { ok: true } | { ok: false; code: 'too_large'; message: string } {
  // An object or array state is estimated as its JSON text; it is still sent
  // as-is on the wire (./provider puts `request.state` into the body untouched).
  const stateText =
    typeof request.state === 'string' ? request.state : JSON.stringify(request.state);
  const stateTokens = estimateTokens(stateText);
  let longest = 0;
  let all = 0;
  for (const question of Object.values(request.questions)) {
    const t = estimateTokens(JSON.stringify(question));
    longest = Math.max(longest, t);
    all += t;
  }
  if (stateTokens + longest > MAX_TOKENS_STATE_PLUS_LONGEST_QUESTION) {
    return {
      ok: false,
      code: 'too_large',
      message: `typesafe: state + longest question ≈ ${stateTokens + longest} tokens exceeds ${MAX_TOKENS_STATE_PLUS_LONGEST_QUESTION}`,
    };
  }
  if (stateTokens + all > MAX_TOKENS_STATE_PLUS_ALL_QUESTIONS) {
    return {
      ok: false,
      code: 'too_large',
      message: `typesafe: state + all questions ≈ ${stateTokens + all} tokens exceeds ${MAX_TOKENS_STATE_PLUS_ALL_QUESTIONS}`,
    };
  }
  return { ok: true };
}
