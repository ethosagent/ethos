import { describe, expect, it } from 'vitest';
import { classifyProbeError, probeProvider } from '../probe-provider';

describe('classifyProbeError (W1.2 liveness split)', () => {
  it('classifies 401/403 status as rejected', () => {
    expect(classifyProbeError({ status: 401 })).toBe('rejected');
    expect(classifyProbeError({ status: 403 })).toBe('rejected');
    expect(classifyProbeError({ statusCode: 401 })).toBe('rejected');
    expect(classifyProbeError({ response: { status: 403 } })).toBe('rejected');
  });

  it('classifies 429 / 5xx status as unreachable', () => {
    expect(classifyProbeError({ status: 429 })).toBe('unreachable');
    expect(classifyProbeError({ status: 500 })).toBe('unreachable');
    expect(classifyProbeError({ status: 503 })).toBe('unreachable');
  });

  it('classifies auth-shaped error messages as rejected', () => {
    expect(classifyProbeError(new Error('401 Unauthorized'))).toBe('rejected');
    expect(classifyProbeError(new Error('invalid api key'))).toBe('rejected');
    expect(classifyProbeError(new Error('authentication failed'))).toBe('rejected');
  });

  it('classifies network / ambiguous errors as unreachable', () => {
    expect(classifyProbeError(new Error('fetch failed'))).toBe('unreachable');
    expect(classifyProbeError(new Error('ETIMEDOUT'))).toBe('unreachable');
    // A non-auth 4xx (e.g. model_not_found on a good key) must NOT be rejected.
    expect(classifyProbeError({ status: 404 })).toBe('unreachable');
    // Unknown → unreachable, never a false "bad key".
    expect(classifyProbeError(new Error('something weird happened'))).toBe('unreachable');
  });
});

describe('probeProvider', () => {
  it('degrades to unreachable when the provider cannot be constructed', async () => {
    const outcome = await probeProvider({
      provider: 'definitely-not-a-real-provider',
      model: 'x',
      apiKey: 'y',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('unreachable');
  });
});
