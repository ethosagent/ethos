// UBP-037 — an overloaded/rate-limit error the Anthropic SDK raises for an SSE
// `error` event mid-stream has NO status (`new APIError(undefined, body, …)`),
// and its message is the JSON body. The chain classifies it by message, so a
// chain fails over (or a pinned call retries) on it exactly as on a 529/429.

import { describe, expect, it } from 'vitest';
import { classifyProviderError } from '../providers/chained-provider';

/** The shape the SDK builds for `event: error` (message = JSON of the body). */
function sseError(type: string): Error {
  const err = new Error(JSON.stringify({ type: 'error', error: { type, message: 'Overloaded' } }));
  return Object.assign(err, { status: undefined, type });
}

describe('classifyProviderError — status-less in-stream errors', () => {
  it('overloaded_error → overloaded', () => {
    expect(classifyProviderError(sseError('overloaded_error'))).toBe('overloaded');
  });

  it('rate_limit_error → rate_limit', () => {
    expect(classifyProviderError(sseError('rate_limit_error'))).toBe('rate_limit');
  });
});
