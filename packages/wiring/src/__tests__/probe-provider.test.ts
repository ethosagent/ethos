import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyProbeError, probeProvider } from '../probe-provider';

const mockCreateLLM = vi.fn();
vi.mock('../index', () => ({
  createLLM: (...args: unknown[]) => mockCreateLLM(...args),
}));

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

  it('does NOT reject on bare forbidden / permission_denied (feature-flag/regional denials)', () => {
    // A valid key denied a region or feature returns these — a false `rejected`
    // would make `--from-env` abort a good deploy.
    expect(classifyProbeError(new Error('permission_denied for this model'))).toBe('unreachable');
    expect(classifyProbeError(new Error('Forbidden: region not enabled'))).toBe('unreachable');
    expect(classifyProbeError(new Error('authentication required soon'))).toBe('unreachable');
  });

  it('classifies DNS / connection-refused as unreachable', () => {
    expect(classifyProbeError(new Error('getaddrinfo ENOTFOUND api.example.com'))).toBe(
      'unreachable',
    );
    expect(classifyProbeError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe('unreachable');
  });
});

describe('probeProvider', () => {
  afterEach(() => {
    mockCreateLLM.mockReset();
  });

  it('degrades to unreachable when the provider cannot be constructed', async () => {
    mockCreateLLM.mockRejectedValueOnce(new Error('unknown provider'));
    const outcome = await probeProvider({
      provider: 'definitely-not-a-real-provider',
      model: 'x',
      apiKey: 'y',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('unreachable');
  });

  it('classifies a 401 from complete() as rejected', async () => {
    mockCreateLLM.mockResolvedValueOnce({
      name: 'anthropic',
      model: 'x',
      // biome-ignore lint/correctness/useYield: throws before yielding
      complete: async function* () {
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
      },
    });
    const outcome = await probeProvider({ provider: 'anthropic', model: 'x', apiKey: 'bad' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('rejected');
      expect(outcome.error).toContain('Unauthorized');
    }
  });

  it('classifies a network error (ECONNREFUSED) from complete() as unreachable', async () => {
    mockCreateLLM.mockResolvedValueOnce({
      name: 'anthropic',
      model: 'x',
      // biome-ignore lint/correctness/useYield: throws before yielding
      complete: async function* () {
        throw new Error('connect ECONNREFUSED 127.0.0.1:443');
      },
    });
    const outcome = await probeProvider({ provider: 'anthropic', model: 'x', apiKey: 'k' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('unreachable');
  });

  it('returns ok with latency when complete() drains cleanly', async () => {
    mockCreateLLM.mockResolvedValueOnce({
      name: 'anthropic',
      model: 'x',
      complete: async function* () {
        yield { type: 'text_delta' as const, text: 'p' };
      },
    });
    const outcome = await probeProvider({ provider: 'anthropic', model: 'x', apiKey: 'k' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(typeof outcome.latencyMs).toBe('number');
  });
});
