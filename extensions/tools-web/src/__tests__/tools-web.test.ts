import { type NetworkPolicy, safeFetch } from '@ethosagent/safety-network';
import type { LLMProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createWebTools, parseMaxAge, toIsoDate, webExtractTool, webSearchTool } from '../index';
import { chunkText, summarizeBySize } from '../summarize';

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
  it('isAvailable stays true with no provider env vars — a vault-only user still gets the tool', () => {
    // A key can arrive from the named-secrets vault via a personality binding,
    // which is not reachable at filter time; env-only gating would wrongly
    // filter web_search out of toDefinitions for a vault-only onboarding.
    const saved = {
      EXA_API_KEY: process.env.EXA_API_KEY,
      TAVILY_API_KEY: process.env.TAVILY_API_KEY,
      BRAVE_API_KEY: process.env.BRAVE_API_KEY,
    };
    delete process.env.EXA_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.BRAVE_API_KEY;
    expect(webSearchTool.isAvailable?.()).toBe(true);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
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

// ---------------------------------------------------------------------------
// Multi-provider web_search — recording fetch asserts URL/headers/body shape
// ---------------------------------------------------------------------------

function makeRecordingFetch(responseBody: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: typeof url === 'string' ? url : url.toString(), init });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { scopedFetch: { fetch }, calls };
}

const SEARCH_ENV_KEYS = ['EXA_API_KEY', 'TAVILY_API_KEY', 'BRAVE_API_KEY'] as const;

function saveSearchEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of SEARCH_ENV_KEYS) saved[k] = process.env[k];
  return saved;
}

function restoreSearchEnv(saved: Record<string, string | undefined>): void {
  for (const k of SEARCH_ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function setOnly(key: (typeof SEARCH_ENV_KEYS)[number]): void {
  for (const k of SEARCH_ENV_KEYS) delete process.env[k];
  process.env[key] = 'test-key';
}

type ScopedFetchLike = {
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
};

function ctxWith(scopedFetch: ScopedFetchLike) {
  return { ...ctx, scopedFetch };
}

describe('web_search — multi-provider', () => {
  it('exa: correct URL, method, x-api-key header, body shape', async () => {
    const saved = saveSearchEnv();
    setOnly('EXA_API_KEY');
    try {
      const rec = makeRecordingFetch({
        results: [
          {
            title: 'T',
            url: 'https://e.com',
            text: 'body',
            publishedDate: '2024-01-02T00:00:00Z',
          },
        ],
      });
      const tool = createWebTools({ searchBackend: 'exa' })[0];
      const result = await tool.execute({ query: 'cats' }, ctxWith(rec.scopedFetch));
      expect(rec.calls[0]?.url).toBe('https://api.exa.ai/search');
      expect(rec.calls[0]?.init?.method).toBe('POST');
      expect(new Headers(rec.calls[0]?.init?.headers).get('x-api-key')).toBe('test-api-key');
      const body = JSON.parse(String(rec.calls[0]?.init?.body));
      expect(body.query).toBe('cats');
      expect(body.numResults).toBe(5);
      expect(body.contents).toBeDefined();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('via exa');
        expect(result.value).toContain('T');
        expect(result.value).toContain('https://e.com');
      }
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it('tavily: correct URL, method, body shape', async () => {
    const saved = saveSearchEnv();
    setOnly('TAVILY_API_KEY');
    try {
      const rec = makeRecordingFetch({
        results: [
          { title: 'TT', url: 'https://t.com', content: 'tbody', published_date: '2024-03-04' },
        ],
      });
      const tool = createWebTools({ searchBackend: 'tavily' })[0];
      const result = await tool.execute({ query: 'dogs' }, ctxWith(rec.scopedFetch));
      expect(rec.calls[0]?.url.startsWith('https://api.tavily.com/search')).toBe(true);
      expect(rec.calls[0]?.init?.method).toBe('POST');
      const body = JSON.parse(String(rec.calls[0]?.init?.body));
      expect(body.api_key).toBe('test-api-key');
      expect(body.max_results).toBe(5);
      expect(body.include_answer).toBe(false);
      expect(body.search_depth).toBe('basic');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('via tavily');
        expect(result.value).toContain('tbody');
      }
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it('brave: correct URL, GET method, X-Subscription-Token header', async () => {
    const saved = saveSearchEnv();
    setOnly('BRAVE_API_KEY');
    try {
      const rec = makeRecordingFetch({
        web: {
          results: [
            { title: 'BB', url: 'https://b.com', description: 'bbody', page_age: '2024-05-06' },
          ],
        },
      });
      const tool = createWebTools({ searchBackend: 'brave' })[0];
      const result = await tool.execute({ query: 'fish' }, ctxWith(rec.scopedFetch));
      expect(
        rec.calls[0]?.url.startsWith('https://api.search.brave.com/res/v1/web/search?q='),
      ).toBe(true);
      expect(rec.calls[0]?.init?.method).toBe('GET');
      expect(new Headers(rec.calls[0]?.init?.headers).get('X-Subscription-Token')).toBe(
        'test-api-key',
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('via brave');
        expect(result.value).toContain('bbody');
      }
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it('auto-detect: exa-only → exa', async () => {
    const saved = saveSearchEnv();
    setOnly('EXA_API_KEY');
    try {
      const rec = makeRecordingFetch({ results: [] });
      await createWebTools({})[0].execute({ query: 'q' }, ctxWith(rec.scopedFetch));
      expect(rec.calls[0]?.url).toBe('https://api.exa.ai/search');
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it('auto-detect: tavily-only → tavily', async () => {
    const saved = saveSearchEnv();
    setOnly('TAVILY_API_KEY');
    try {
      const rec = makeRecordingFetch({ results: [] });
      await createWebTools({})[0].execute({ query: 'q' }, ctxWith(rec.scopedFetch));
      expect(rec.calls[0]?.url.startsWith('https://api.tavily.com/search')).toBe(true);
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it('auto-detect: brave-only → brave', async () => {
    const saved = saveSearchEnv();
    setOnly('BRAVE_API_KEY');
    try {
      const rec = makeRecordingFetch({ web: { results: [] } });
      await createWebTools({})[0].execute({ query: 'q' }, ctxWith(rec.scopedFetch));
      expect(rec.calls[0]?.url.startsWith('https://api.search.brave.com/res/v1/web/search')).toBe(
        true,
      );
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it('explicit override picks brave even when exa is also available', async () => {
    const saved = saveSearchEnv();
    for (const k of SEARCH_ENV_KEYS) delete process.env[k];
    process.env.BRAVE_API_KEY = 'test-key';
    process.env.EXA_API_KEY = 'test-key';
    try {
      const rec = makeRecordingFetch({ web: { results: [] } });
      await createWebTools({ searchBackend: 'brave' })[0].execute(
        { query: 'q' },
        ctxWith(rec.scopedFetch),
      );
      expect(rec.calls[0]?.url.startsWith('https://api.search.brave.com/res/v1/web/search')).toBe(
        true,
      );
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it('no backend available → not_available', async () => {
    const saved = saveSearchEnv();
    for (const k of SEARCH_ENV_KEYS) delete process.env[k];
    try {
      const rec = makeRecordingFetch({});
      const result = await createWebTools({})[0].execute({ query: 'x' }, ctxWith(rec.scopedFetch));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('not_available');
    } finally {
      restoreSearchEnv(saved);
    }
  });
});

// ---------------------------------------------------------------------------
// web_search — per-personality provider + named-secret resolution
// ---------------------------------------------------------------------------

function makeRecordingSecrets(value = 'bound-key') {
  const refs: string[] = [];
  return {
    refs,
    get: async (ref: string): Promise<string> => {
      refs.push(ref);
      return value;
    },
  };
}

function ctxFor(
  scopedFetch: ScopedFetchLike,
  personalityId: string | undefined,
  secrets: { get: (ref: string) => Promise<string> },
) {
  return {
    ...ctx,
    scopedFetch,
    secretsResolver: secrets,
    ...(personalityId ? { personalityId } : {}),
  };
}

describe('web_search — provider + named-secret resolution', () => {
  it('personality tools.yaml wins over global toolSettings', async () => {
    const rec = makeRecordingFetch({ results: [] });
    const secrets = makeRecordingSecrets();
    const tool = createWebTools({
      resolvePersonalitySetting: (pid) =>
        pid === 'researcher' ? { provider: 'exa', secret: 'exa-main' } : undefined,
      toolSettings: {
        researcher: { web_search: { provider: 'tavily', secret: 'tav' } },
        _default: { web_search: { provider: 'brave', secret: 'br' } },
      },
    })[0];
    const result = await tool.execute(
      { query: 'q' },
      ctxFor(rec.scopedFetch, 'researcher', secrets),
    );
    expect(result.ok).toBe(true);
    expect(rec.calls[0]?.url).toBe('https://api.exa.ai/search');
    expect(secrets.refs).toContain('providers/exa/exa-main');
  });

  it('built-in with no file falls back to global toolSettings[personalityId]', async () => {
    const rec = makeRecordingFetch({ web: { results: [] } });
    const secrets = makeRecordingSecrets();
    const tool = createWebTools({
      toolSettings: {
        scout: { web_search: { provider: 'brave', secret: 'brave-main' } },
        _default: { web_search: { provider: 'tavily', secret: 'tav' } },
      },
    })[0];
    await tool.execute({ query: 'q' }, ctxFor(rec.scopedFetch, 'scout', secrets));
    expect(rec.calls[0]?.url.startsWith('https://api.search.brave.com')).toBe(true);
    expect(secrets.refs).toContain('providers/brave/brave-main');
  });

  it('falls through to _default when no personality-specific slot exists', async () => {
    const rec = makeRecordingFetch({ results: [] });
    const secrets = makeRecordingSecrets();
    const tool = createWebTools({
      toolSettings: { _default: { web_search: { provider: 'tavily', secret: 'tav' } } },
    })[0];
    await tool.execute({ query: 'q' }, ctxFor(rec.scopedFetch, 'nobody', secrets));
    expect(rec.calls[0]?.url.startsWith('https://api.tavily.com/search')).toBe(true);
    expect(secrets.refs).toContain('providers/tavily/tav');
  });

  it('provider binding without a secret name uses the default-named secret', async () => {
    const rec = makeRecordingFetch({ results: [] });
    const secrets = makeRecordingSecrets();
    const tool = createWebTools({
      resolvePersonalitySetting: () => ({ provider: 'exa' }),
    })[0];
    await tool.execute({ query: 'q' }, ctxFor(rec.scopedFetch, 'researcher', secrets));
    expect(secrets.refs).toContain('providers/exa/apiKey');
  });

  it('bound-secret read succeeds and the tool never reads a raw value from the personality dir', async () => {
    // The personality setting carries only a NAME; the VALUE is read from the
    // vault (secretsResolver) via a providers/<provider>/<name> ref.
    const rec = makeRecordingFetch({
      results: [{ title: 'T', url: 'https://e.com', text: 'body' }],
    });
    const secrets = makeRecordingSecrets('super-secret-value');
    const tool = createWebTools({
      resolvePersonalitySetting: () => ({ provider: 'exa', secret: 'exa-main' }),
    })[0];
    const result = await tool.execute(
      { query: 'q' },
      ctxFor(rec.scopedFetch, 'researcher', secrets),
    );
    expect(result.ok).toBe(true);
    // Only a vault ref was resolved — never a literal value.
    expect(secrets.refs).toEqual(['providers/exa/exa-main']);
    expect(new Headers(rec.calls[0]?.init?.headers).get('x-api-key')).toBe('super-secret-value');
  });

  it('backward compat: nothing specified anywhere → first-available (unchanged)', async () => {
    const saved = saveSearchEnv();
    setOnly('TAVILY_API_KEY');
    try {
      const rec = makeRecordingFetch({ results: [] });
      const tool = createWebTools({})[0];
      await tool.execute({ query: 'q' }, ctxFor(rec.scopedFetch, 'researcher', mockSecrets));
      expect(rec.calls[0]?.url.startsWith('https://api.tavily.com/search')).toBe(true);
    } finally {
      restoreSearchEnv(saved);
    }
  });
});

// ---------------------------------------------------------------------------
// Exa availability — aligned on EXA_API_KEY (not the stale ETHOS_EXA_API_KEY)
// ---------------------------------------------------------------------------

describe('web_search — Exa availability env fix', () => {
  it('ETHOS_EXA_API_KEY (stale name) does not auto-select exa', async () => {
    // The tool itself is now always registered (a key can come from the vault),
    // so availability no longer keys off env. But the env-based AUTO-SELECT path
    // must still honor only the canonical `EXA_API_KEY` — the stale
    // `ETHOS_EXA_API_KEY` name must not resolve a backend. With no personality
    // binding and only the stale name set, execute finds no backend.
    const saved = saveSearchEnv();
    const savedLegacy = process.env.ETHOS_EXA_API_KEY;
    for (const k of SEARCH_ENV_KEYS) delete process.env[k];
    process.env.ETHOS_EXA_API_KEY = 'legacy';
    try {
      const result = await createWebTools({})[0].execute({ query: 'q' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('not_available');
    } finally {
      restoreSearchEnv(saved);
      if (savedLegacy === undefined) delete process.env.ETHOS_EXA_API_KEY;
      else process.env.ETHOS_EXA_API_KEY = savedLegacy;
    }
  });
});

// ---------------------------------------------------------------------------
// summarize.ts — pure tier logic
// ---------------------------------------------------------------------------

describe('summarizeBySize', () => {
  const s = async (x: string) => `SUMMARY(${x.length})`;

  it('returns text as-is below 5,000 chars', async () => {
    const raw = 'a'.repeat(4999);
    const result = await summarizeBySize(raw, s);
    expect('value' in result && result.value === raw).toBe(true);
  });

  it('single-pass summary at 5,000 chars', async () => {
    const result = await summarizeBySize('a'.repeat(5000), s);
    expect('value' in result && result.value === 'SUMMARY(5000)').toBe(true);
  });

  it('single-pass summary just below 500,000 chars', async () => {
    const result = await summarizeBySize('a'.repeat(499999), s);
    expect('value' in result && result.value === 'SUMMARY(499999)').toBe(true);
  });

  it('chunked into 10 at 500,000 chars', async () => {
    const result = await summarizeBySize('a'.repeat(500000), s);
    expect('value' in result).toBe(true);
    if ('value' in result) expect(result.value.split('\n\n').length).toBe(10);
  });

  it('chunked into 40 just below 2,000,000 chars', async () => {
    const result = await summarizeBySize('a'.repeat(1999999), s);
    expect('value' in result).toBe(true);
    if ('value' in result) expect(result.value.split('\n\n').length).toBe(40);
  });

  it('refuses at 2,000,000 chars', async () => {
    const result = await summarizeBySize('a'.repeat(2000000), s);
    expect('tooLarge' in result).toBe(true);
  });

  it('chunkText splits evenly', () => {
    const chunks = chunkText('abcdef', 2);
    expect(chunks).toHaveLength(3);
    expect(chunks).toEqual(['ab', 'cd', 'ef']);
  });
});

// ---------------------------------------------------------------------------
// web_extract — size-tiered summarization
// ---------------------------------------------------------------------------

function makeHtmlRecordingFetch(html: string) {
  const fetch = async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
    new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  return { fetch };
}

const fakeProvider = {
  name: 'fake',
  model: 'm',
  maxContextTokens: 1000,
  supportsCaching: false,
  supportsThinking: false,
  complete: async function* () {
    yield { type: 'text_delta', text: 'EXTRACTED' };
  },
  countTokens: async () => 0,
} as unknown as LLMProvider;

describe('web_extract — summarization', () => {
  it('summarizes large pages when aux model is configured', async () => {
    const html = `<html><body>${'word '.repeat(2000)}</body></html>`;
    const scopedFetch = makeHtmlRecordingFetch(html);
    const tool = createWebTools({ auxModel: 'm', resolveProvider: () => fakeProvider })[1];
    const result = await tool.execute({ url: 'https://example.com/article' }, ctxWith(scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('[https://example.com/article]\n\nEXTRACTED');
    }
  });

  it('returns raw truncated text when no aux model is configured', async () => {
    const html = `<html><body>${'word '.repeat(2000)}</body></html>`;
    const scopedFetch = makeHtmlRecordingFetch(html);
    const tool = createWebTools({})[1];
    const result = await tool.execute({ url: 'https://example.com/article' }, ctxWith(scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.startsWith('[https://example.com/article]\n\n')).toBe(true);
      expect(result.value).not.toContain('EXTRACTED');
    }
  });

  it('refuses pages over 2,000,000 chars', async () => {
    const html = `<html><body>${'a'.repeat(2_000_001)}</body></html>`;
    const scopedFetch = makeHtmlRecordingFetch(html);
    const tool = createWebTools({ auxModel: 'm', resolveProvider: () => fakeProvider })[1];
    const result = await tool.execute({ url: 'https://example.com/article' }, ctxWith(scopedFetch));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toMatch(/too large/);
    }
  });
});

// ---------------------------------------------------------------------------
// max_age → each backend's own native recency parameter.
//
// The regression these pin is silent: a wrong parameter name is IGNORED by the
// provider, which returns unfiltered results while the caller believes the
// filter is on. Each assertion is against the request the backend actually
// builds, and each name was confirmed against the provider's current docs:
//   exa     startPublishedDate (ISO 8601)  https://exa.ai/docs/reference/search
//   tavily  start_date (YYYY-MM-DD)
//           https://docs.tavily.com/documentation/api-reference/endpoint/search
//   brave   freshness (YYYY-MM-DDtoYYYY-MM-DD range form)
//           https://api-dashboard.search.brave.com/app/documentation/web-search/query
//   searxng time_range (day|month|year — no week, no date form)
//           https://docs.searxng.org/dev/search_api.html
//
// Three of the four take an absolute instant, so an arbitrary duration reaches
// them exactly. Only SearXNG buckets, and only it ever widens.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

/** `YYYY-MM-DD`, `days` before `at`. Assertions accept the value computed from
 *  either side of the call so a midnight boundary cannot flake the test. */
function ymdBack(days: number, at: number): string {
  return new Date(at - days * DAY).toISOString().slice(0, 10);
}

describe('web_search — max_age maps to each backend\u2019s native parameter', () => {
  it('exa: startPublishedDate, ISO 8601, the exact requested instant', async () => {
    const saved = saveSearchEnv();
    setOnly('EXA_API_KEY');
    try {
      const rec = makeRecordingFetch({ results: [] });
      // Bracketed on BOTH sides: the backend samples its own `Date.now()` at
      // call time, so a single `before` sample would only hold if zero
      // milliseconds elapsed during the call. The cutoff must land inside the
      // window the two samples allow — exact, and immune to call duration.
      const before = Date.now();
      await createWebTools({ searchBackend: 'exa' })[0].execute(
        { query: 'q', max_age: '30d' },
        ctxWith(rec.scopedFetch),
      );
      const after = Date.now();
      const body = JSON.parse(String(rec.calls[0]?.init?.body));
      expect(typeof body.startPublishedDate).toBe('string');
      expect(body.startPublishedDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const cutoff = Date.parse(body.startPublishedDate);
      expect(cutoff).toBeGreaterThanOrEqual(before - 30 * DAY);
      expect(cutoff).toBeLessThanOrEqual(after - 30 * DAY);
      // The deprecated crawl-date fields are never sent.
      expect(body.startCrawlDate).toBeUndefined();
      expect(body.endCrawlDate).toBeUndefined();
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it('exa: no startPublishedDate at all when max_age is omitted', async () => {
    const saved = saveSearchEnv();
    setOnly('EXA_API_KEY');
    try {
      const rec = makeRecordingFetch({ results: [] });
      await createWebTools({ searchBackend: 'exa' })[0].execute(
        { query: 'q' },
        ctxWith(rec.scopedFetch),
      );
      const body = JSON.parse(String(rec.calls[0]?.init?.body));
      expect('startPublishedDate' in body).toBe(false);
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it.each([
    ['1d', 1],
    ['2w', 14],
    ['6m', 180], // not expressible as any enum window — the point of the grammar
    ['1y', 365],
  ] as const)('exa: %s → startPublishedDate %d days back', async (maxAge, days) => {
    const saved = saveSearchEnv();
    setOnly('EXA_API_KEY');
    try {
      const rec = makeRecordingFetch({ results: [] });
      // Bracketed on both sides for the reason given above: a single `before`
      // sample makes the assertion depend on the call taking zero milliseconds.
      const before = Date.now();
      await createWebTools({ searchBackend: 'exa' })[0].execute(
        { query: 'q', max_age: maxAge },
        ctxWith(rec.scopedFetch),
      );
      const after = Date.now();
      const body = JSON.parse(String(rec.calls[0]?.init?.body));
      const cutoff = Date.parse(body.startPublishedDate);
      expect(cutoff).toBeGreaterThanOrEqual(before - days * DAY);
      expect(cutoff).toBeLessThanOrEqual(after - days * DAY);
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it.each([
    ['30d', 30],
    ['6m', 180],
  ] as const)('tavily: %s → start_date YYYY-MM-DD, %d days back', async (maxAge, days) => {
    const saved = saveSearchEnv();
    setOnly('TAVILY_API_KEY');
    try {
      const rec = makeRecordingFetch({ results: [] });
      const before = Date.now();
      await createWebTools({ searchBackend: 'tavily' })[0].execute(
        { query: 'q', max_age: maxAge },
        ctxWith(rec.scopedFetch),
      );
      const after = Date.now();
      const body = JSON.parse(String(rec.calls[0]?.init?.body));
      expect(body.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect([ymdBack(days, before), ymdBack(days, after)]).toContain(body.start_date);
      // The coarser bucket parameter is NOT sent alongside it.
      expect('time_range' in body).toBe(false);
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it('tavily: no start_date or time_range key at all when max_age is omitted', async () => {
    const saved = saveSearchEnv();
    setOnly('TAVILY_API_KEY');
    try {
      const rec = makeRecordingFetch({ results: [] });
      await createWebTools({ searchBackend: 'tavily' })[0].execute(
        { query: 'q' },
        ctxWith(rec.scopedFetch),
      );
      const body = JSON.parse(String(rec.calls[0]?.init?.body));
      expect('start_date' in body).toBe(false);
      expect('time_range' in body).toBe(false);
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it.each([
    ['30d', 30],
    ['6m', 180],
  ] as const)('brave: %s → freshness=<date>to<date>, %d days back', async (maxAge, days) => {
    const saved = saveSearchEnv();
    setOnly('BRAVE_API_KEY');
    try {
      const rec = makeRecordingFetch({ web: { results: [] } });
      const before = Date.now();
      await createWebTools({ searchBackend: 'brave' })[0].execute(
        { query: 'q', max_age: maxAge },
        ctxWith(rec.scopedFetch),
      );
      const after = Date.now();
      const freshness = new URL(rec.calls[0]?.url ?? '').searchParams.get('freshness') ?? '';
      expect(freshness).toMatch(/^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/);
      const [from, to] = freshness.split('to');
      expect([ymdBack(days, before), ymdBack(days, after)]).toContain(from);
      expect([ymdBack(0, before), ymdBack(0, after)]).toContain(to);
      // Never the coarse buckets, which could only approximate the window.
      expect(freshness).not.toMatch(/^p[dwmy]$/);
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it('brave: no freshness param at all when max_age is omitted', async () => {
    const saved = saveSearchEnv();
    setOnly('BRAVE_API_KEY');
    try {
      const rec = makeRecordingFetch({ web: { results: [] } });
      await createWebTools({ searchBackend: 'brave' })[0].execute(
        { query: 'q' },
        ctxWith(rec.scopedFetch),
      );
      expect(new URL(rec.calls[0]?.url ?? '').searchParams.has('freshness')).toBe(false);
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it.each([
    ['1d', 'day'],
    ['30d', 'month'],
    ['6m', 'year'],
    ['1y', 'year'],
  ] as const)('searxng: %s → time_range=%s (never narrower)', async (maxAge, mapped) => {
    const saved = saveSearchEnv();
    for (const k of SEARCH_ENV_KEYS) delete process.env[k];
    try {
      const rec = makeRecordingFetch({ results: [] });
      await createWebTools({ searxngUrl: 'https://searx.internal' })[0].execute(
        { query: 'q', max_age: maxAge },
        ctxWith(rec.scopedFetch),
      );
      expect(new URL(rec.calls[0]?.url ?? '').searchParams.get('time_range')).toBe(mapped);
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it('searxng: past a year, no time_range at all — every bucket would narrow', async () => {
    const saved = saveSearchEnv();
    for (const k of SEARCH_ENV_KEYS) delete process.env[k];
    try {
      const rec = makeRecordingFetch({
        results: [{ title: 'T', url: 'https://a.example/1', content: 'body' }],
      });
      const result = await createWebTools({ searxngUrl: 'https://searx.internal' })[0].execute(
        { query: 'q', max_age: '2y' },
        ctxWith(rec.scopedFetch),
      );
      expect(new URL(rec.calls[0]?.url ?? '').searchParams.has('time_range')).toBe(false);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('could not be requested upstream at all');
        expect(result.value).toContain('no publication date are included');
      }
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it('searxng: a widened bucket is applied AND disclosed', async () => {
    const saved = saveSearchEnv();
    for (const k of SEARCH_ENV_KEYS) delete process.env[k];
    try {
      const rec = makeRecordingFetch({
        results: [{ title: 'T', url: 'https://a.example/1', content: 'body' }],
      });
      const result = await createWebTools({ searxngUrl: 'https://searx.internal' })[0].execute(
        { query: 'q', max_age: '30d' },
        ctxWith(rec.scopedFetch),
      );
      // Widened, not dropped: `month` is a superset of 30 days, so nothing the
      // caller wanted is lost — and `filterByMaxAge` trims the tail locally.
      expect(new URL(rec.calls[0]?.url ?? '').searchParams.get('time_range')).toBe('month');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('last 30 days');
        expect(result.value).toContain("requested upstream as 'month'");
      }
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it('searxng: no time_range param at all when max_age is omitted', async () => {
    const saved = saveSearchEnv();
    for (const k of SEARCH_ENV_KEYS) delete process.env[k];
    try {
      const rec = makeRecordingFetch({ results: [] });
      await createWebTools({ searxngUrl: 'https://searx.internal' })[0].execute(
        { query: 'q' },
        ctxWith(rec.scopedFetch),
      );
      expect(new URL(rec.calls[0]?.url ?? '').searchParams.has('time_range')).toBe(false);
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it('a backend that CAN express the window adds no note', async () => {
    const saved = saveSearchEnv();
    setOnly('BRAVE_API_KEY');
    try {
      const rec = makeRecordingFetch({
        web: { results: [{ title: 'B', url: 'https://b.com', description: 'x' }] },
      });
      const result = await createWebTools({ searchBackend: 'brave' })[0].execute(
        { query: 'q', max_age: '6m' },
        ctxWith(rec.scopedFetch),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('— last 6 months (via brave)');
        expect(result.value).not.toContain('Note:');
      }
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it('refuses an unparseable window rather than silently searching unfiltered', async () => {
    const saved = saveSearchEnv();
    setOnly('BRAVE_API_KEY');
    try {
      const rec = makeRecordingFetch({ web: { results: [] } });
      const result = await createWebTools({ searchBackend: 'brave' })[0].execute(
        { query: 'q', max_age: '30x' },
        ctxWith(rec.scopedFetch),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('input_invalid');
        // The refusal names the grammar, not just the bad value.
        expect(result.error).toContain('d|w|m|y');
      }
      expect(rec.calls).toHaveLength(0);
    } finally {
      restoreSearchEnv(saved);
    }
  });
});

// ---------------------------------------------------------------------------
// The local post-filter is what ENFORCES the window (D5); the provider
// parameter is only the request. Brave here stands in for any backend.
// ---------------------------------------------------------------------------

describe('web_search — the window is enforced locally', () => {
  it('drops a dated hit outside the window and keeps an undated one', async () => {
    const saved = saveSearchEnv();
    setOnly('BRAVE_API_KEY');
    try {
      const rec = makeRecordingFetch({
        web: {
          results: [
            {
              title: 'Fresh',
              url: 'https://b.com/1',
              description: 'x',
              page_age: ymdBack(1, Date.now()),
            },
            { title: 'Stale', url: 'https://b.com/2', description: 'y', page_age: '2020-01-01' },
            { title: 'Undated', url: 'https://b.com/3', description: 'z' },
          ],
        },
      });
      const result = await createWebTools({ searchBackend: 'brave' })[0].execute(
        { query: 'q', max_age: '30d' },
        ctxWith(rec.scopedFetch),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('**Fresh**');
        expect(result.value).not.toContain('**Stale**');
        // Undated hits are KEPT — the stated limitation, not an oversight.
        expect(result.value).toContain('**Undated**');
      }
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it('an emptied result set names the window instead of reading as a fact about the web', async () => {
    const saved = saveSearchEnv();
    setOnly('BRAVE_API_KEY');
    try {
      const rec = makeRecordingFetch({
        web: {
          results: [
            { title: 'Stale', url: 'https://b.com/2', description: 'y', page_age: '2020-01-01' },
          ],
        },
      });
      const result = await createWebTools({ searchBackend: 'brave' })[0].execute(
        { query: 'q', max_age: '30d' },
        ctxWith(rec.scopedFetch),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('No results found for: q in the last 30 days (via brave)');
      }
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it('an empty result with no window set is worded exactly as before', async () => {
    const saved = saveSearchEnv();
    setOnly('BRAVE_API_KEY');
    try {
      const rec = makeRecordingFetch({ web: { results: [] } });
      const result = await createWebTools({ searchBackend: 'brave' })[0].execute(
        { query: 'q' },
        ctxWith(rec.scopedFetch),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('No results found for: q');
    } finally {
      restoreSearchEnv(saved);
    }
  });
});

// ---------------------------------------------------------------------------
// D8 precedence — call argument → binding `recency` → unset.
// ---------------------------------------------------------------------------

describe('web_search — recency binding precedence', () => {
  function braveWith(recency: string) {
    return createWebTools({
      searchBackend: 'brave',
      toolSettings: { _default: { web_search: { recency } } },
    })[0];
  }

  it('applies the binding when the call argument is absent', async () => {
    const saved = saveSearchEnv();
    setOnly('BRAVE_API_KEY');
    try {
      const rec = makeRecordingFetch({ web: { results: [] } });
      const before = Date.now();
      await braveWith('7d').execute({ query: 'q' }, ctxWith(rec.scopedFetch));
      const after = Date.now();
      const freshness = new URL(rec.calls[0]?.url ?? '').searchParams.get('freshness') ?? '';
      expect([ymdBack(7, before), ymdBack(7, after)]).toContain(freshness.split('to')[0]);
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it('the call argument beats the binding', async () => {
    const saved = saveSearchEnv();
    setOnly('BRAVE_API_KEY');
    try {
      const rec = makeRecordingFetch({ web: { results: [] } });
      const before = Date.now();
      await braveWith('7d').execute({ query: 'q', max_age: '1y' }, ctxWith(rec.scopedFetch));
      const after = Date.now();
      const freshness = new URL(rec.calls[0]?.url ?? '').searchParams.get('freshness') ?? '';
      expect([ymdBack(365, before), ymdBack(365, after)]).toContain(freshness.split('to')[0]);
    } finally {
      restoreSearchEnv(saved);
    }
  });

  it('an INVALID binding value is ignored, not refused — a stale stored setting must not break every search', async () => {
    const saved = saveSearchEnv();
    setOnly('BRAVE_API_KEY');
    try {
      const rec = makeRecordingFetch({
        web: { results: [{ title: 'B', url: 'https://b.com', description: 'x' }] },
      });
      const result = await braveWith('fortnight').execute({ query: 'q' }, ctxWith(rec.scopedFetch));
      expect(result.ok).toBe(true);
      expect(new URL(rec.calls[0]?.url ?? '').searchParams.has('freshness')).toBe(false);
      if (result.ok) expect(result.value).not.toContain('last');
    } finally {
      restoreSearchEnv(saved);
    }
  });
});

// ---------------------------------------------------------------------------
// Date rendering — never invented, never defaulted, never today.
// ---------------------------------------------------------------------------

describe('toIsoDate', () => {
  it('normalizes every shape the backends actually send to YYYY-MM-DD', () => {
    expect(toIsoDate('2024-01-02T00:00:00Z')).toBe('2024-01-02'); // exa
    expect(toIsoDate('2024-03-04')).toBe('2024-03-04'); // tavily (plain)
    expect(toIsoDate('Mon, 09 Feb 2025 00:00:00 GMT')).toBe('2025-02-09'); // tavily (RFC 1123)
    expect(toIsoDate('2024-05-06T12:34:56')).toBe('2024-05-06'); // brave page_age
  });

  it('returns null — never a fabricated or today’s date — for absent or unreadable input', () => {
    expect(toIsoDate(undefined)).toBeNull();
    expect(toIsoDate('')).toBeNull();
    expect(toIsoDate('   ')).toBeNull();
    expect(toIsoDate('sometime last year')).toBeNull();
  });
});

describe('web_search — date rendering', () => {
  it('renders the backend’s date as ISO, and nothing when there is none', async () => {
    const saved = saveSearchEnv();
    setOnly('BRAVE_API_KEY');
    try {
      const rec = makeRecordingFetch({
        web: {
          results: [
            { title: 'Dated', url: 'https://b.com/1', description: 'x', page_age: '2024-05-06' },
            { title: 'Undated', url: 'https://b.com/2', description: 'y' },
          ],
        },
      });
      const result = await createWebTools({ searchBackend: 'brave' })[0].execute(
        { query: 'q' },
        ctxWith(rec.scopedFetch),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('1. **Dated** (2024-05-06)');
        expect(result.value).toContain('2. **Undated**\n');
        // No parenthesised date anywhere on the undated entry's heading line.
        expect(result.value).not.toMatch(/2\. \*\*Undated\*\* \(/);
      }
    } finally {
      restoreSearchEnv(saved);
    }
  });
});

describe('web_search settingsSchema (Phase 2 contract)', () => {
  it('declares a minimal provider enum + secret-binding schema', () => {
    const schema = webSearchTool.settingsSchema;
    if (!schema) throw new Error('expected web_search to declare a settingsSchema');
    expect(schema.fields.map((f) => f.kind)).toEqual(['enum', 'secret-binding', 'enum']);
    const provider = schema.fields[0];
    if (provider?.kind !== 'enum') throw new Error('expected provider enum field');
    expect(provider.key).toBe('provider');
    expect(provider.options.map((o) => o.value)).toEqual(['exa', 'tavily', 'brave']);
    const secret = schema.fields[1];
    if (secret?.kind !== 'secret-binding') throw new Error('expected secret-binding field');
    expect(secret.secretKind).toBe('web-search');
  });

  it('declares a recency enum whose every option parses under parseMaxAge', () => {
    const schema = webSearchTool.settingsSchema;
    if (!schema) throw new Error('expected web_search to declare a settingsSchema');
    const recency = schema.fields[2];
    if (recency?.kind !== 'enum') throw new Error('expected recency enum field');
    expect(recency.key).toBe('recency');
    expect(recency.options.map((o) => o.value)).toEqual(['7d', '30d', '90d', '6m', '1y']);

    // The point of this assertion: the dropdown's values ARE `max_age` values,
    // so the stored default cannot drift into a second grammar. Every option
    // round-trips through the same parser the call argument uses.
    for (const option of recency.options) {
      expect(parseMaxAge(option.value)?.raw).toBe(option.value);
      expect(option.label).toBeTruthy();
    }

    // Unset is unset — no "none"/empty-string option, and no default, so an
    // unchosen (or cleared) binding means no recency filter.
    expect(recency.default).toBeUndefined();
    expect(recency.options.some((o) => o.value === '')).toBe(false);
  });
});

// Q-130 / Q-149 / D45 — per-hit excerpt length.
describe('web_search — max_chars', () => {
  // 'z' appears nowhere in the header or the title, so the longest run of it
  // is exactly the kept excerpt.
  const LONG = 'z'.repeat(3_000);

  function excerptLength(value: string): number {
    return Math.max(0, ...(value.match(/z+/g) ?? []).map((m) => m.length));
  }

  async function search(
    backend: 'exa' | 'tavily' | 'brave',
    args: Record<string, unknown>,
  ): Promise<{ result: Awaited<ReturnType<typeof webSearchTool.execute>>; call?: RequestInit }> {
    const saved = saveSearchEnv();
    setOnly(`${backend.toUpperCase()}_API_KEY` as (typeof SEARCH_ENV_KEYS)[number]);
    try {
      const response =
        backend === 'exa'
          ? { results: [{ title: 'T', url: 'https://e.com', text: LONG }] }
          : backend === 'tavily'
            ? { results: [{ title: 'T', url: 'https://t.com', content: LONG }] }
            : { web: { results: [{ title: 'T', url: 'https://b.com', description: LONG }] } };
      const rec = makeRecordingFetch(response);
      const tool = createWebTools({ searchBackend: backend })[0];
      const result = await tool.execute({ query: 'q', ...args }, ctxWith(rec.scopedFetch));
      return { result, call: rec.calls[0]?.init };
    } finally {
      restoreSearchEnv(saved);
    }
  }

  it('defaults to 400 characters per hit, with the Exa request unchanged', async () => {
    const { result, call } = await search('exa', {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(excerptLength(result.value)).toBe(400);
    expect(JSON.parse(String(call?.body)).contents).toEqual({ text: { maxCharacters: 1500 } });
  });

  it('keeps 1,200 characters when asked, still requesting 1,500 from Exa', async () => {
    const { result, call } = await search('exa', { max_chars: 1_200 });
    if (!result.ok) throw new Error(result.error);
    expect(excerptLength(result.value)).toBe(1_200);
    expect(JSON.parse(String(call?.body)).contents.text.maxCharacters).toBe(1500);
  });

  it('asks Exa for max_chars when it exceeds 1,500', async () => {
    const { result, call } = await search('exa', { max_chars: 1_800 });
    if (!result.ok) throw new Error(result.error);
    expect(excerptLength(result.value)).toBe(1_800);
    expect(JSON.parse(String(call?.body)).contents.text.maxCharacters).toBe(1_800);
  });

  it.each([
    [50, 100],
    [0, 100],
    [99_999, 2_000],
    [700.6, 701],
  ])('clamps max_chars %s to %s', async (asked, kept) => {
    const { result } = await search('exa', { max_chars: asked });
    if (!result.ok) throw new Error(result.error);
    expect(excerptLength(result.value)).toBe(kept);
  });

  it.each(['tavily', 'brave'] as const)(
    'cuts %s text to max_chars without changing the request',
    async (backend) => {
      const { result, call } = await search(backend, { max_chars: 1_200 });
      if (!result.ok) throw new Error(result.error);
      expect(excerptLength(result.value)).toBe(1_200);
      const sent = `${call?.body ?? ''}`;
      expect(sent).not.toMatch(/max_?chars|maxCharacters/i);
    },
  );

  it('refuses a max_chars that is not a number', async () => {
    const { result } = await search('exa', { max_chars: '1200' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  // D37's enforcer: a caller (the Brand Brain plugin) may send arguments an
  // older or newer web_search does not know; the call must still succeed.
  it('an unrecognised argument does not fail the call', async () => {
    const { result } = await search('exa', { not_a_real_argument: true });
    expect(result.ok).toBe(true);
  });
});
