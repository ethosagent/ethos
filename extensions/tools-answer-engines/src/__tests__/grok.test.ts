import type { ToolContext } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { grokEngine } from '../engines/grok';
import { secretGrantsOf } from '../engines/roster';
import { EngineHttpError, EngineNoKeyError, type EngineRequest } from '../engines/types';
import { createEngineAskTool } from '../index';
import { GROK_RECORDED } from './fixtures/grok.recorded';

function makeRecordingFetch(responseBody: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: typeof url === 'string' ? url : url.toString(), init });
    const body = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
  return { scopedFetch: { fetch }, calls };
}

function makeCtx(
  scopedFetch: { fetch: (url: string | URL, init?: RequestInit) => Promise<Response> },
  secrets = { get: async (_ref: string) => 'test-api-key' },
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
    model: 'grok-4.6',
    searchContextSize: 'medium',
    requireSearch: false,
    maxCitations: 20,
    ...overrides,
  };
}

const REF = 'providers/xai/apiKey';

/** One message whose annotations are given verbatim. */
function messageWith(annotations: unknown[], text = 'An answer.') {
  return {
    model: 'grok-4.6',
    output: [{ type: 'message', content: [{ type: 'output_text', text, annotations }] }],
  };
}

const bodyOf = (call: { init?: RequestInit } | undefined) => JSON.parse(String(call?.init?.body));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('grok engine — identity', () => {
  it('declares id, label, host, namespace grant, supports, default model and env var', () => {
    expect(grokEngine.id).toBe('grok');
    expect(grokEngine.label).toBe('xAI');
    expect(grokEngine.hosts).toEqual(['api.x.ai']);
    expect(grokEngine.secretPrefix).toBe('providers/xai/');
    expect(grokEngine.defaultSecretRef).toBe('providers/xai/apiKey');
    expect(grokEngine.bindable).toBe(true);
    expect(secretGrantsOf(grokEngine)).toEqual(['providers/xai/*']);
    expect(grokEngine.supports).toEqual({
      country: false,
      searchContextSize: false,
      requireSearch: true,
    });
    expect(grokEngine.defaultModel).toBe('grok-4.6');
    expect(grokEngine.modelEnvVar).toBe('XAI_ANSWER_ENGINE_MODEL');
  });
});

describe('grok engine — request body', () => {
  it('POSTs a one-message input, a bare web_search tool and store:false to /v1/responses', async () => {
    const rec = makeRecordingFetch(GROK_RECORDED);
    await grokEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.url).toBe('https://api.x.ai/v1/responses');
    expect(rec.calls[0]?.init?.method).toBe('POST');
    expect(new Headers(rec.calls[0]?.init?.headers).get('Authorization')).toBe(
      'Bearer test-api-key',
    );
    expect(bodyOf(rec.calls[0])).toEqual({
      model: 'grok-4.6',
      input: [{ role: 'user', content: 'Which Indian banks offer the best travel credit cards?' }],
      tools: [{ type: 'web_search' }],
      tool_choice: 'auto',
      store: false,
    });
  });

  it('tool_choice follows require_search', async () => {
    const rec = makeRecordingFetch(GROK_RECORDED);
    await grokEngine.ask(req({ requireSearch: true }), makeCtx(rec.scopedFetch), REF);
    expect(bodyOf(rec.calls[0]).tool_choice).toBe('required');
  });

  // The one test in this file that is not stylistic: xAI REJECTS a request
  // carrying either field (plan §4.1), so sending one fails the call.
  it('never sends search_context_size, user_location or external_web_access — even when given', async () => {
    const rec = makeRecordingFetch(GROK_RECORDED);
    await grokEngine.ask(
      req({ country: 'IN', searchContextSize: 'high' }),
      makeCtx(rec.scopedFetch),
      REF,
    );
    const raw = String(rec.calls[0]?.init?.body);
    for (const field of ['search_context_size', 'user_location', 'external_web_access']) {
      expect(raw).not.toContain(field);
    }
    expect(raw).not.toContain('"IN"');
    expect(bodyOf(rec.calls[0]).tools).toEqual([{ type: 'web_search' }]);
  });

  it('threads ctx.abortSignal and resolves the key through the given ref', async () => {
    const rec = makeRecordingFetch(GROK_RECORDED);
    const refs: string[] = [];
    const ctx = makeCtx(rec.scopedFetch, {
      get: async (ref: string) => {
        refs.push(ref);
        return 'bound';
      },
    });
    await grokEngine.ask(req(), ctx, 'providers/xai/grok-brand');
    expect(refs).toEqual(['providers/xai/grok-brand']);
    expect(rec.calls[0]?.init?.signal).toBe(ctx.abortSignal);
  });

  it('the model follows XAI_ANSWER_ENGINE_MODEL and createEngineAskTool({ models: { grok } })', async () => {
    const recEnv = makeRecordingFetch(GROK_RECORDED);
    await createEngineAskTool({ env: { XAI_ANSWER_ENGINE_MODEL: 'grok-env' } }).execute(
      { query: 'q', engine: 'grok' },
      makeCtx(recEnv.scopedFetch),
    );
    expect(bodyOf(recEnv.calls[0]).model).toBe('grok-env');

    const recOpt = makeRecordingFetch(GROK_RECORDED);
    await createEngineAskTool({
      models: { grok: 'grok-opt' },
      env: { XAI_ANSWER_ENGINE_MODEL: 'grok-env' },
    }).execute({ query: 'q', engine: 'grok' }, makeCtx(recOpt.scopedFetch));
    expect(bodyOf(recOpt.calls[0]).model).toBe('grok-opt');
  });

  it('goes through ctx.scopedFetch, never globalThis.fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const rec = makeRecordingFetch(GROK_RECORDED);
    await grokEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(rec.calls).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('grok engine — response parsing', () => {
  it('parses the recorded-shape fixture', async () => {
    const rec = makeRecordingFetch(GROK_RECORDED);
    const answer = await grokEngine.ask(req({ country: 'IN' }), makeCtx(rec.scopedFetch), REF);
    expect(answer).toMatchObject({
      engine: 'grok',
      model: 'grok-4.6',
      searched: true,
      searchCalls: 2,
      usage: { inputTokens: 2150, outputTokens: 312 },
    });
    // Never sent, so never claimed on the record.
    expect(answer.country).toBeUndefined();
    expect(answer.answerText.startsWith('Axis Atlas is the most-recommended')).toBe(true);
    expect(answer.citations).toEqual([
      {
        url: 'https://www.cardexpert.in/best-travel-credit-cards/',
        domain: 'cardexpert.in',
        position: 1,
      },
      {
        url: 'https://www.paisabazaar.com/credit-cards/travel/',
        domain: 'paisabazaar.com',
        position: 2,
      },
    ]);
    expect(answer.sources).toEqual([
      { url: 'https://www.cardexpert.in/best-travel-credit-cards/', domain: 'cardexpert.in' },
      { url: 'https://www.paisabazaar.com/credit-cards/travel/', domain: 'paisabazaar.com' },
      { url: 'https://www.axisbank.com/atlas', domain: 'axisbank.com' },
    ]);
  });

  it('orders by start_index when present, even against the citation number', async () => {
    const rec = makeRecordingFetch(
      messageWith([
        { type: 'url_citation', url: 'https://b.example/', start_index: 20, title: '1' },
        { type: 'url_citation', url: 'https://a.example/', start_index: 5, title: '2' },
      ]),
    );
    const answer = await grokEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.citations.map((c) => c.url)).toEqual([
      'https://a.example/',
      'https://b.example/',
    ]);
  });

  it('with offsets absent, orders by the numeric title; position matches it', async () => {
    const rec = makeRecordingFetch(
      messageWith([
        { type: 'url_citation', url: 'https://three.example/', title: '3' },
        { type: 'url_citation', url: 'https://one.example/', title: '1' },
        { type: 'url_citation', url: 'https://two.example/', title: '2' },
      ]),
    );
    const answer = await grokEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.citations.map((c) => [c.url, c.position])).toEqual([
      ['https://one.example/', 1],
      ['https://two.example/', 2],
      ['https://three.example/', 3],
    ]);
  });

  it('with neither offset nor number, keeps annotation array order', async () => {
    const rec = makeRecordingFetch(
      messageWith([
        { type: 'url_citation', url: 'https://z.example/' },
        { type: 'url_citation', url: 'https://a.example/', title: 'not a number' },
        { type: 'url_citation', url: 'https://m.example/' },
      ]),
    );
    const answer = await grokEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.citations.map((c) => c.url)).toEqual([
      'https://z.example/',
      'https://a.example/',
      'https://m.example/',
    ]);
  });

  it("citations[].title is never set — xAI's title is a number, not a page title", async () => {
    const rec = makeRecordingFetch(GROK_RECORDED);
    const answer = await grokEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    for (const c of answer.citations) expect(c.title).toBeUndefined();
  });

  it('de-duplicates by exact URL, keeps two spellings apart, and renumbers after the cap', async () => {
    const annotations = [
      { type: 'url_citation', url: 'https://ex.example/p', start_index: 1 },
      { type: 'url_citation', url: 'https://ex.example/p', start_index: 2 },
      { type: 'url_citation', url: 'https://ex.example/p/', start_index: 3 },
      { type: 'url_citation', url: 'https://ex.example/p?page=2', start_index: 4 },
    ];
    const rec = makeRecordingFetch(messageWith(annotations));
    const all = await grokEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(all.citations.map((c) => c.url)).toEqual([
      'https://ex.example/p',
      'https://ex.example/p/',
      'https://ex.example/p?page=2',
    ]);
    const capped = await grokEngine.ask(req({ maxCitations: 2 }), makeCtx(rec.scopedFetch), REF);
    expect(capped.citations.map((c) => c.position)).toEqual([1, 2]);
  });

  it('searchCalls falls back to the web_search_call item count', async () => {
    const rec = makeRecordingFetch({
      ...GROK_RECORDED,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const answer = await grokEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.searchCalls).toBe(2);
  });

  it('no web_search_call and no usage count: not searched', async () => {
    const rec = makeRecordingFetch(messageWith([]));
    const answer = await grokEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.searched).toBe(false);
    expect(answer.searchCalls).toBe(0);
    expect(answer.sources).toEqual([]);
  });
});

describe('grok engine — failures', () => {
  it('an empty ref throws EngineNoKeyError before any network call', async () => {
    const rec = makeRecordingFetch(GROK_RECORDED);
    await expect(
      grokEngine.ask(req(), makeCtx(rec.scopedFetch, { get: async () => '' }), REF),
    ).rejects.toBeInstanceOf(EngineNoKeyError);
    expect(rec.calls).toHaveLength(0);
  });

  it('a non-2xx throws EngineHttpError labelled xAI', async () => {
    const rec = makeRecordingFetch('z'.repeat(900), 429);
    const err: unknown = await grokEngine.ask(req(), makeCtx(rec.scopedFetch), REF).catch((e) => e);
    if (!(err instanceof EngineHttpError)) throw new Error('expected EngineHttpError');
    expect(err.status).toBe(429);
    expect(err.message.startsWith('xAI API error 429')).toBe(true);
    expect(err.message.match(/z+/)?.[0]).toHaveLength(500);
  });

  // xAI has no 401: a bad key and a bad request are both 400 (plan D7).
  it("through the tool: empty resolve → not_available with the xAI message; 400 → execution_failed with xAI's body", async () => {
    const tool = createEngineAskTool();
    const recEmpty = makeRecordingFetch(GROK_RECORDED);
    const empty = await tool.execute(
      { query: 'q', engine: 'grok' },
      makeCtx(recEmpty.scopedFetch, { get: async () => '' }),
    );
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.code).toBe('not_available');
      expect(empty.error).toContain('XAI_API_KEY');
      expect(empty.error).toContain('HTTP 400');
    }

    const rec400 = makeRecordingFetch(
      { code: 'invalid-argument', error: 'Incorrect API key' },
      400,
    );
    const bad = await tool.execute({ query: 'q', engine: 'grok' }, makeCtx(rec400.scopedFetch));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe('execution_failed');
      expect(bad.error).toContain('xAI API error 400');
      expect(bad.error).toContain('Incorrect API key');
    }
  });
});
