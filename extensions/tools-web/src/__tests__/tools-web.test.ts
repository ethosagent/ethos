import { type NetworkPolicy, safeFetch } from '@ethosagent/safety-network';
import { describe, expect, it } from 'vitest';
import { createWebTools, webExtractTool, webSearchTool } from '../index';

// ---------------------------------------------------------------------------
// Helpers — ScopedFetch backed by the REAL safeFetch from safety-network
// ---------------------------------------------------------------------------

/**
 * Build a ScopedFetch that delegates to the real `safeFetch` pipeline (scheme
 * check + cloud-metadata block + private-network block + redirect revalidation).
 *
 * DNS resolution and the underlying `fetch` are stubbed so tests are hermetic,
 * but the blocking logic itself is the production code from @ethosagent/safety-network.
 * This means the web tool tests exercise the real SSRF validator instead of
 * hand-rolling an incomplete copy of the rules.
 */
function makeScopedFetch(policy: NetworkPolicy = {}) {
  const stubFetch = async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
    new Response('OK', { status: 200 });
  const stubResolver = async (_hostname: string): Promise<string[]> => ['93.184.216.34']; // public IP

  return {
    fetch: async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const u = typeof url === 'string' ? url : url.toString();
      const { redirect: _redirect, ...rest } = init ?? {};
      const result = await safeFetch(u, {
        policy,
        fetchImpl: stubFetch,
        resolveHost: stubResolver,
        init: rest,
      });
      if (!result.ok) {
        throw new Error(`HOST_NOT_ALLOWED: ${result.reason}`);
      }
      return result.response;
    },
  };
}

const mockSecrets = {
  get: async (_ref: string) => 'test-api-key',
};

const mockFetch = makeScopedFetch();

const ctx = {
  sessionId: 'test',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 80_000,
  secretsResolver: mockSecrets,
  scopedFetch: mockFetch,
};

const ctxWithoutCapabilities = {
  sessionId: 'test',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 80_000,
};

describe('createWebTools', () => {
  it('returns 2 tools', () => {
    expect(createWebTools()).toHaveLength(2);
  });
});

describe('web_search', () => {
  it('isAvailable returns false when ETHOS_EXA_API_KEY is not set', () => {
    const saved = process.env.ETHOS_EXA_API_KEY;
    delete process.env.ETHOS_EXA_API_KEY;
    expect(webSearchTool.isAvailable?.()).toBe(false);
    if (saved) process.env.ETHOS_EXA_API_KEY = saved;
  });

  it('isAvailable returns true when ETHOS_EXA_API_KEY is set', () => {
    const saved = process.env.ETHOS_EXA_API_KEY;
    process.env.ETHOS_EXA_API_KEY = 'test-key';
    expect(webSearchTool.isAvailable?.()).toBe(true);
    if (saved) process.env.ETHOS_EXA_API_KEY = saved;
    else delete process.env.ETHOS_EXA_API_KEY;
  });

  it('returns not_available when capability backends are missing', async () => {
    const result = await webSearchTool.execute({ query: 'test' }, ctxWithoutCapabilities);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });

  it('returns input_invalid if query is missing', async () => {
    const result = await webSearchTool.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });
});

describe('web_extract', () => {
  it('returns input_invalid for missing url', async () => {
    const result = await webExtractTool.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('returns not_available when capability backends are missing', async () => {
    const result = await webExtractTool.execute(
      { url: 'https://example.com' },
      ctxWithoutCapabilities,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });

  it('propagates fetch errors for malformed urls', async () => {
    const result = await webExtractTool.execute({ url: 'not-a-url' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
    }
  });

  it('propagates fetch errors for non-http protocols', async () => {
    const result = await webExtractTool.execute({ url: 'ftp://example.com' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toMatch(/HOST_NOT_ALLOWED/);
    }
  });

  it('succeeds for normal public URLs', async () => {
    const result = await webExtractTool.execute({ url: 'https://example.com/' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('https://example.com/');
    }
  });
});

// ---------------------------------------------------------------------------
// SSRF protection — integration tests that verify web_extract surfaces
// HOST_NOT_ALLOWED rejections from scopedFetch as execution_failed errors.
//
// The mock scopedFetch above delegates to the real safeFetch pipeline from
// @ethosagent/safety-network (with stubbed DNS + fetch). This means the
// blocking logic tested here IS the production code — no hand-rolled rules.
//
// Fine-grained edge-case coverage (full 172.16.0.0/12, IPv6 ULA, DNS
// rebinding, redirect revalidation, etc.) lives in
// packages/safety/network/src/__tests__/safe-fetch.test.ts.
// ---------------------------------------------------------------------------

describe('web_extract — SSRF protection', () => {
  it.each([
    ['cloud-metadata IP', 'http://169.254.169.254/latest/meta-data/'],
    ['cloud-metadata hostname', 'http://metadata.google.internal/computeMetadata/v1/'],
    ['loopback', 'http://127.0.0.1/'],
    ['RFC1918 private', 'http://10.0.0.1/internal-api'],
    ['IPv6 loopback', 'http://[::1]/'],
  ])('blocks SSRF attempt: %s (%s)', async (_label, url) => {
    const result = await webExtractTool.execute({ url }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toMatch(/SSRF blocked/);
    }
  });

  it.each([
    ['file:// scheme', 'file:///etc/passwd'],
    ['data: scheme', 'data:text/html,<h1>evil</h1>'],
    ['javascript: scheme', 'javascript:alert(1)'],
  ])('blocks dangerous scheme: %s (%s)', async (_label, url) => {
    const result = await webExtractTool.execute({ url }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
    }
  });

  it('uses scopedFetch, not raw fetch', () => {
    // web_extract declares capabilities.network — the framework resolves
    // this to a ScopedFetchImpl at registration time. Verify the tool
    // definition declares the capability.
    expect(webExtractTool.capabilities.network).toBeDefined();
    expect(webExtractTool.capabilities.network?.allowedHosts).toContain('*');
  });
});
