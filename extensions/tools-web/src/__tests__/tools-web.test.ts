import { type NetworkPolicy, safeFetch } from '@ethosagent/safety-network';
import type { LLMProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createWebTools, webExtractTool, webSearchTool } from '../index';
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
  it('isAvailable returns false when EXA_API_KEY is not set', () => {
    const saved = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;
    expect(webSearchTool.isAvailable?.()).toBe(false);
    if (saved) process.env.EXA_API_KEY = saved;
  });

  it('isAvailable returns true when EXA_API_KEY is set', () => {
    const saved = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = 'test-key';
    expect(webSearchTool.isAvailable?.()).toBe(true);
    if (saved) process.env.EXA_API_KEY = saved;
    else delete process.env.EXA_API_KEY;
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
  it('ETHOS_EXA_API_KEY alone does NOT make exa available', () => {
    const saved = saveSearchEnv();
    const savedLegacy = process.env.ETHOS_EXA_API_KEY;
    for (const k of SEARCH_ENV_KEYS) delete process.env[k];
    process.env.ETHOS_EXA_API_KEY = 'legacy';
    try {
      expect(webSearchTool.isAvailable?.()).toBe(false);
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

describe('web_search settingsSchema (Phase 2 contract)', () => {
  it('declares a minimal provider enum + secret-binding schema', () => {
    const schema = webSearchTool.settingsSchema;
    if (!schema) throw new Error('expected web_search to declare a settingsSchema');
    expect(schema.fields.map((f) => f.kind)).toEqual(['enum', 'secret-binding']);
    const provider = schema.fields[0];
    if (provider?.kind !== 'enum') throw new Error('expected provider enum field');
    expect(provider.key).toBe('provider');
    expect(provider.options.map((o) => o.value)).toEqual(['exa', 'tavily', 'brave']);
    const secret = schema.fields[1];
    if (secret?.kind !== 'secret-binding') throw new Error('expected secret-binding field');
    expect(secret.secretKind).toBe('web-search');
  });
});
