import type { ToolContext } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { microsoftEngine, resetMicrosoftTokenCacheForTests } from '../engines/microsoft';
import { secretGrantsOf } from '../engines/roster';
import { EngineNoKeyError, type EngineRequest } from '../engines/types';
import { createEngineAskTool } from '../index';
import { MICROSOFT_RECORDED } from './fixtures/microsoft.recorded';

const ENDPOINT = 'https://contoso-ai.services.ai.azure.com/api/projects/brand-watch';
const TOKEN_URL = 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token';
const RESPONSES_URL = `${ENDPOINT}/openai/v1/responses`;

const VAULT: Record<string, string> = {
  'providers/microsoft-foundry/projectEndpoint': ENDPOINT,
  'providers/microsoft-foundry/tenantId': 'tenant-1',
  'providers/microsoft-foundry/clientId': 'client-1',
  'providers/microsoft-foundry/clientSecret': 'secret-1',
};

function vault(overrides: Record<string, string> = {}) {
  const table = { ...VAULT, ...overrides };
  return { get: async (ref: string) => table[ref] ?? '' };
}

/**
 * Routes the Entra mint and the Foundry call. `tokenStatus` / `foundryStatus`
 * shape the two legs; `expiresIn` is the minted token's lifetime.
 */
function makeRouter(
  opts: { tokenStatus?: number; foundryStatus?: number; expiresIn?: number; body?: unknown } = {},
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let minted = 0;
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = typeof url === 'string' ? url : url.toString();
    calls.push({ url: u, init });
    if (u.startsWith('https://login.microsoftonline.com/')) {
      minted += 1;
      return new Response(
        JSON.stringify({
          token_type: 'Bearer',
          expires_in: opts.expiresIn ?? 3599,
          access_token: `token-${minted}`,
        }),
        { status: opts.tokenStatus ?? 200 },
      );
    }
    return new Response(JSON.stringify(opts.body ?? MICROSOFT_RECORDED), {
      status: opts.foundryStatus ?? 200,
    });
  };
  return {
    scopedFetch: { fetch },
    calls,
    mints: () => calls.filter((c) => c.url === TOKEN_URL).length,
  };
}

function makeCtx(
  scopedFetch: { fetch: (url: string | URL, init?: RequestInit) => Promise<Response> },
  secrets: { get: (ref: string) => Promise<string> } = vault(),
): ToolContext {
  return {
    sessionId: 'test',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    secretsResolver: secrets,
    scopedFetch,
  };
}

function req(overrides: Partial<EngineRequest> = {}): EngineRequest {
  return {
    query: 'Which Indian banks offer the best travel credit cards?',
    model: 'brand-gpt',
    searchContextSize: 'medium',
    requireSearch: false,
    maxCitations: 20,
    ...overrides,
  };
}

const REF = 'providers/microsoft-foundry/clientSecret';
const foundryCalls = (calls: Array<{ url: string; init?: RequestInit }>) =>
  calls.filter((c) => c.url === RESPONSES_URL);

beforeEach(() => {
  resetMicrosoftTokenCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('microsoft engine — identity', () => {
  it('declares two hosts, four exact-ref grants, no binding, full supports', () => {
    expect(microsoftEngine.id).toBe('microsoft');
    expect(microsoftEngine.label).toBe('Microsoft');
    expect(microsoftEngine.hosts).toEqual(['login.microsoftonline.com', '*.services.ai.azure.com']);
    expect(microsoftEngine.bindable).toBe(false);
    expect(microsoftEngine.defaultSecretRef).toBe(REF);
    expect(secretGrantsOf(microsoftEngine)).toEqual([
      'providers/microsoft-foundry/projectEndpoint',
      'providers/microsoft-foundry/tenantId',
      'providers/microsoft-foundry/clientId',
      'providers/microsoft-foundry/clientSecret',
    ]);
    expect(microsoftEngine.supports).toEqual({
      country: true,
      searchContextSize: true,
      requireSearch: true,
    });
    expect(microsoftEngine.modelEnvVar).toBe('FOUNDRY_ANSWER_ENGINE_DEPLOYMENT');
  });
});

describe('microsoft engine — token mint', () => {
  it('mints with a form-encoded client_credentials body scoped to ai.azure.com, then calls Foundry with the token', async () => {
    const r = makeRouter();
    const ctx = makeCtx(r.scopedFetch);
    await microsoftEngine.ask(req(), ctx, REF);
    expect(r.calls.map((c) => c.url)).toEqual([TOKEN_URL, RESPONSES_URL]);
    const mint = r.calls[0];
    expect(mint?.init?.method).toBe('POST');
    expect(new Headers(mint?.init?.headers).get('Content-Type')).toBe(
      'application/x-www-form-urlencoded',
    );
    const form = new URLSearchParams(String(mint?.init?.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'client-1',
      client_secret: 'secret-1',
      scope: 'https://ai.azure.com/.default',
    });
    // Both legs carry the turn's abort signal, so a halt cancels either.
    expect(mint?.init?.signal).toBe(ctx.abortSignal);
    expect(r.calls[1]?.init?.signal).toBe(ctx.abortSignal);
    expect(new Headers(r.calls[1]?.init?.headers).get('Authorization')).toBe('Bearer token-1');
  });

  it('caches the token: two asks in a row produce one mint', async () => {
    const r = makeRouter();
    await microsoftEngine.ask(req(), makeCtx(r.scopedFetch), REF);
    await microsoftEngine.ask(req(), makeCtx(r.scopedFetch), REF);
    expect(r.mints()).toBe(1);
    expect(foundryCalls(r.calls)).toHaveLength(2);
  });

  it('re-mints once the cached token is inside the 300s expiry margin', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-18T00:00:00Z'));
    const r = makeRouter({ expiresIn: 600 });
    await microsoftEngine.ask(req(), makeCtx(r.scopedFetch), REF);
    vi.setSystemTime(new Date('2026-09-18T00:04:00Z')); // 360s left: still cached
    await microsoftEngine.ask(req(), makeCtx(r.scopedFetch), REF);
    expect(r.mints()).toBe(1);
    vi.setSystemTime(new Date('2026-09-18T00:05:30Z')); // 270s left: inside the margin
    await microsoftEngine.ask(req(), makeCtx(r.scopedFetch), REF);
    expect(r.mints()).toBe(2);
  });

  it('a non-2xx mint is a credential failure: not_available with the Microsoft message, no Foundry call', async () => {
    const r = makeRouter({ tokenStatus: 401 });
    await expect(microsoftEngine.ask(req(), makeCtx(r.scopedFetch), REF)).rejects.toBeInstanceOf(
      EngineNoKeyError,
    );
    const result = await createEngineAskTool().execute(
      { query: 'q', engine: 'microsoft' },
      makeCtx(r.scopedFetch),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toContain('Foundry User role');
      expect(result.error).toContain('AZURE_CLIENT_SECRET');
    }
    expect(foundryCalls(r.calls)).toHaveLength(0);
  });

  it('a Foundry 401 → not_available, drops the cached token, never retries; the next call mints again', async () => {
    const r401 = makeRouter({ foundryStatus: 401 });
    const tool = createEngineAskTool();
    const result = await tool.execute(
      { query: 'q', engine: 'microsoft' },
      makeCtx(r401.scopedFetch),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
    expect(r401.mints()).toBe(1);
    expect(foundryCalls(r401.calls)).toHaveLength(1);

    const rOk = makeRouter();
    await microsoftEngine.ask(req(), makeCtx(rOk.scopedFetch), REF);
    expect(rOk.mints()).toBe(1);
  });
});

describe('microsoft engine — endpoint and credentials', () => {
  it.each([
    'http://contoso-ai.services.ai.azure.com/api/projects/p',
    'https://contoso.openai.azure.com/api/projects/p',
    'https://services.ai.azure.com.evil.example/api/projects/p',
    'https://.services.ai.azure.com/api/projects/p',
    'not a url',
    // Host right, path wrong: Foundry would answer 404, not the shape error.
    'https://contoso-ai.services.ai.azure.com',
    'https://contoso-ai.services.ai.azure.com/api/projects/',
    'https://contoso-ai.services.ai.azure.com/other',
    'https://contoso-ai.services.ai.azure.com/api/projects/p/extra',
  ])('refuses the endpoint %s with a shape error and no fetch at all', async (endpoint) => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const r = makeRouter();
    const result = await createEngineAskTool().execute(
      { query: 'q', engine: 'microsoft' },
      makeCtx(r.scopedFetch, vault({ 'providers/microsoft-foundry/projectEndpoint': endpoint })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('.services.ai.azure.com/api/projects/<project>');
    }
    expect(r.calls).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('any one of the four refs empty → not_available naming all four, before any fetch', async () => {
    for (const ref of Object.keys(VAULT)) {
      const r = makeRouter();
      const result = await createEngineAskTool().execute(
        { query: 'q', engine: 'microsoft' },
        makeCtx(r.scopedFetch, vault({ [ref]: '' })),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('not_available');
        for (const env of [
          'FOUNDRY_PROJECT_ENDPOINT',
          'AZURE_TENANT_ID',
          'AZURE_CLIENT_ID',
          'AZURE_CLIENT_SECRET',
        ]) {
          expect(result.error).toContain(env);
        }
      }
      expect(r.calls).toHaveLength(0);
    }
  });

  it('a trailing slash on the endpoint is tolerated', async () => {
    const r = makeRouter();
    await microsoftEngine.ask(
      req(),
      makeCtx(
        r.scopedFetch,
        vault({ 'providers/microsoft-foundry/projectEndpoint': `${ENDPOINT}/` }),
      ),
      REF,
    );
    expect(foundryCalls(r.calls)).toHaveLength(1);
  });
});

describe('microsoft engine — request and response', () => {
  it('sends the deployment as model, tool_choice from require_search, and both country and search_context_size', async () => {
    const r = makeRouter();
    await microsoftEngine.ask(
      req({ country: 'GB', searchContextSize: 'high', requireSearch: true }),
      makeCtx(r.scopedFetch),
      REF,
    );
    const body = JSON.parse(String(foundryCalls(r.calls)[0]?.init?.body));
    expect(body).toEqual({
      model: 'brand-gpt',
      input: 'Which Indian banks offer the best travel credit cards?',
      tool_choice: 'required',
      tools: [
        {
          type: 'web_search',
          search_context_size: 'high',
          user_location: { type: 'approximate', country: 'GB' },
        },
      ],
    });

    const r2 = makeRouter();
    await microsoftEngine.ask(req(), makeCtx(r2.scopedFetch), REF);
    expect(JSON.parse(String(foundryCalls(r2.calls)[0]?.init?.body)).tool_choice).toBe('auto');
  });

  it('parses the recorded-shape fixture: no titles, sources always empty', async () => {
    const r = makeRouter();
    const answer = await microsoftEngine.ask(req({ country: 'IN' }), makeCtx(r.scopedFetch), REF);
    expect(answer).toMatchObject({
      engine: 'microsoft',
      model: 'gpt-5.5',
      country: 'IN',
      searched: true,
      searchCalls: 1,
      sources: [],
      usage: { inputTokens: 1480, outputTokens: 44 },
    });
    expect(answer.citations).toEqual([
      {
        url: 'https://www.cardexpert.in/best-travel-credit-cards/',
        domain: 'cardexpert.in',
        position: 1,
      },
      { url: 'https://www.hdfcbank.com/infinia', domain: 'hdfcbank.com', position: 2 },
    ]);
  });

  it('the { type, url }-only payload variant orders by annotation array order', async () => {
    const r = makeRouter({
      body: {
        model: 'gpt-5.5',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Answer.',
                annotations: [
                  { type: 'url_citation', url: 'https://z.example/' },
                  { type: 'url_citation', url: 'https://a.example/' },
                  { type: 'url_citation', url: 'https://z.example/' },
                ],
              },
            ],
          },
        ],
      },
    });
    const answer = await microsoftEngine.ask(req(), makeCtx(r.scopedFetch), REF);
    expect(answer.citations.map((c) => [c.url, c.title, c.position])).toEqual([
      ['https://z.example/', undefined, 1],
      ['https://a.example/', undefined, 2],
    ]);
    // Citations without a web_search_call item: reported as not searched —
    // grounding is never inferred from the presence of citations (parent D4).
    expect(answer.searched).toBe(false);
    expect(answer.searchCalls).toBe(0);
  });

  it('a Foundry 500 is execution_failed labelled Microsoft', async () => {
    const r = makeRouter({ foundryStatus: 500 });
    const result = await createEngineAskTool().execute(
      { query: 'q', engine: 'microsoft' },
      makeCtx(r.scopedFetch),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('Microsoft API error 500');
    }
  });
});
