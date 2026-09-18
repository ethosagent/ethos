import type { ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { perplexityEngine } from '../engines/perplexity';
import { EngineHttpError, EngineNoKeyError, type EngineRequest } from '../engines/types';

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
    model: 'low',
    searchContextSize: 'medium',
    requireSearch: false,
    maxCitations: 20,
    ...overrides,
  };
}

const REF = 'providers/perplexity/apiKey';

const baseFixture = {
  id: 'resp_1',
  object: 'response',
  status: 'completed',
  model: 'openai/gpt-5.6-luna',
  output: [
    {
      type: 'search_results',
      queries: ['best travel credit cards india'],
      results: [
        {
          id: 1,
          url: 'https://www.CardExpert.in/best',
          title: 'CardExpert',
          snippet: 'Axis Atlas leads the pack.',
          date: '2026-05-01',
          last_updated: '2026-05-02',
          source: 'web',
        },
        {
          id: 2,
          url: 'https://paisabazaar.com/cards',
          title: 'Paisabazaar',
          snippet: 'HDFC Infinia is a close second.',
          date: '2026-04-11',
          last_updated: '2026-04-12',
          source: 'web',
        },
      ],
    },
    {
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: 'Axis Atlas leads[web:1], then HDFC Infinia[web:2].',
          annotations: [],
        },
      ],
    },
  ],
  usage: {
    input_tokens: 1200,
    output_tokens: 300,
    total_tokens: 1500,
    cost: { total_cost: 0.0123 },
    tool_calls_details: { search_web: { invocation: 1 } },
  },
};

/** One `search_results` item with `ids` results and one message carrying `text`. */
function fixtureWith(results: Array<{ id: number; url: string; title?: string }>, text: string) {
  return {
    id: 'resp_2',
    object: 'response',
    status: 'completed',
    model: 'openai/gpt-5.6-luna',
    output: [
      { type: 'search_results', queries: ['q'], results },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  };
}

describe('perplexity engine — identity', () => {
  it('declares id, label, host, secret prefix, default ref, grant, default model and env var', () => {
    expect(perplexityEngine.id).toBe('perplexity');
    expect(perplexityEngine.label).toBe('Perplexity');
    expect(perplexityEngine.host).toBe('api.perplexity.ai');
    expect(perplexityEngine.secretPrefix).toBe('providers/perplexity/');
    expect(perplexityEngine.defaultSecretRef).toBe('providers/perplexity/apiKey');
    expect(perplexityEngine.secretGrant).toBe('providers/perplexity/apiKey');
    expect(perplexityEngine.defaultModel).toBe('low');
    expect(perplexityEngine.modelEnvVar).toBe('PERPLEXITY_ANSWER_ENGINE_PRESET');
  });
});

describe('perplexity engine — request body', () => {
  it('POSTs the question as the entire input to the Agent API endpoint', async () => {
    const rec = makeRecordingFetch(baseFixture);
    await perplexityEngine.ask(req(), makeCtx(rec.scopedFetch), REF);

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.url).toBe('https://api.perplexity.ai/v1/agent');
    expect(rec.calls[0]?.init?.method).toBe('POST');
    expect(new Headers(rec.calls[0]?.init?.headers).get('Authorization')).toBe(
      'Bearer test-api-key',
    );
    const body = JSON.parse(String(rec.calls[0]?.init?.body));
    expect(body.preset).toBe('low');
    expect(body.input).toBe('Which Indian banks offer the best travel credit cards?');
    expect(typeof body.input).toBe('string');
  });

  it('sends the request model verbatim as the preset', async () => {
    const rec = makeRecordingFetch(baseFixture);
    await perplexityEngine.ask(req({ model: 'fast' }), makeCtx(rec.scopedFetch), REF);
    const body = JSON.parse(String(rec.calls[0]?.init?.body));
    expect(body.preset).toBe('fast');
  });

  it('sends web_search with search_context_size and no user_location by default', async () => {
    const rec = makeRecordingFetch(baseFixture);
    await perplexityEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    const body = JSON.parse(String(rec.calls[0]?.init?.body));
    expect(body.tools).toEqual([{ type: 'web_search', search_context_size: 'medium' }]);
  });

  it('adds user_location only when country is set, and forwards search_context_size', async () => {
    const rec = makeRecordingFetch(baseFixture);
    await perplexityEngine.ask(
      req({ country: 'IN', searchContextSize: 'high' }),
      makeCtx(rec.scopedFetch),
      REF,
    );
    const body = JSON.parse(String(rec.calls[0]?.init?.body));
    expect(body.tools[0]).toEqual({
      type: 'web_search',
      search_context_size: 'high',
      user_location: { country: 'IN' },
    });
  });

  it('sends none of the chat-completions-era keys and store:false', async () => {
    const rec = makeRecordingFetch(baseFixture);
    await perplexityEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    const body = JSON.parse(String(rec.calls[0]?.init?.body));
    expect('instructions' in body).toBe(false);
    expect('model' in body).toBe(false);
    expect('tool_choice' in body).toBe(false);
    expect('filters' in body).toBe(false);
    expect('max_results' in body).toBe(false);
    expect(body.store).toBe(false);
    expect('max_results' in body.tools[0]).toBe(false);
  });

  it('require_search is a documented no-op for Perplexity — the body is byte-identical', async () => {
    const recDefault = makeRecordingFetch(baseFixture);
    await perplexityEngine.ask(req({ requireSearch: false }), makeCtx(recDefault.scopedFetch), REF);
    const recRequired = makeRecordingFetch(baseFixture);
    await perplexityEngine.ask(req({ requireSearch: true }), makeCtx(recRequired.scopedFetch), REF);
    expect(String(recRequired.calls[0]?.init?.body)).toBe(String(recDefault.calls[0]?.init?.body));
  });

  it('threads ctx.abortSignal into the fetch', async () => {
    const rec = makeRecordingFetch(baseFixture);
    const ctx = makeCtx(rec.scopedFetch);
    await perplexityEngine.ask(req(), ctx, REF);
    expect(rec.calls[0]?.init?.signal).toBe(ctx.abortSignal);
  });

  it('resolves the key through the given secretRef, never a hardcoded one', async () => {
    const rec = makeRecordingFetch(baseFixture);
    const refs: string[] = [];
    const secrets = {
      get: async (ref: string) => {
        refs.push(ref);
        return 'bound-key';
      },
    };
    await perplexityEngine.ask(
      req(),
      makeCtx(rec.scopedFetch, secrets),
      'providers/perplexity/other',
    );
    expect(refs).toEqual(['providers/perplexity/other']);
    expect(new Headers(rec.calls[0]?.init?.headers).get('Authorization')).toBe('Bearer bound-key');
  });
});

describe('perplexity engine — response parsing', () => {
  it('baseFixture: engine, model, searched, searchCalls, verbatim answerText, citations, sources', async () => {
    const rec = makeRecordingFetch(baseFixture);
    const answer = await perplexityEngine.ask(req(), makeCtx(rec.scopedFetch), REF);

    expect(answer.engine).toBe('perplexity');
    expect(answer.model).toBe('openai/gpt-5.6-luna');
    expect(answer.searched).toBe(true);
    expect(answer.searchCalls).toBe(1);
    expect(answer.answerText).toBe('Axis Atlas leads[web:1], then HDFC Infinia[web:2].');
    expect(answer.citations).toEqual([
      {
        url: 'https://www.CardExpert.in/best',
        title: 'CardExpert',
        domain: 'cardexpert.in',
        position: 1,
      },
      {
        url: 'https://paisabazaar.com/cards',
        title: 'Paisabazaar',
        domain: 'paisabazaar.com',
        position: 2,
      },
    ]);
    expect(answer.sources).toEqual([
      { url: 'https://www.CardExpert.in/best', domain: 'cardexpert.in' },
      { url: 'https://paisabazaar.com/cards', domain: 'paisabazaar.com' },
    ]);
    // This toEqual is also what proves `usage.cost` never reaches the record —
    // cost is passed through as tokens only (parent D10).
    expect(answer.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
    expect(answer.query).toBe('Which Indian banks offer the best travel credit cards?');
    expect(answer.country).toBeUndefined();
  });

  it('the bare [1] dialect resolves the same way as [web:1]', async () => {
    const rec = makeRecordingFetch(
      fixtureWith(
        [{ id: 1, url: 'https://a.example.com/x', title: 'A' }],
        'Answer with a bare marker[1].',
      ),
    );
    const answer = await perplexityEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.citations).toHaveLength(1);
    expect(answer.citations[0]?.url).toBe('https://a.example.com/x');
    expect(answer.citations[0]?.domain).toBe('a.example.com');
  });

  // Citations follow the order the markers appear in the prose, not the id
  // order the search results happened to come back in.
  it('orders citations by first appearance in the answer text, not by id', async () => {
    const rec = makeRecordingFetch(
      fixtureWith(
        [
          { id: 1, url: 'https://one.example/a' },
          { id: 2, url: 'https://two.example/b' },
          { id: 3, url: 'https://three.example/c' },
        ],
        'Third first[web:3], then first[web:1], then second[web:2].',
      ),
    );
    const answer = await perplexityEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.citations.map((c) => c.url)).toEqual([
      'https://three.example/c',
      'https://one.example/a',
      'https://two.example/b',
    ]);
    expect(answer.citations[0]?.position).toBe(1);
    expect(answer.citations[0]?.title).toBeUndefined();
  });

  it('a marker naming an id no result carries produces no citation', async () => {
    const rec = makeRecordingFetch(
      fixtureWith([{ id: 1, url: 'https://one.example/a' }], 'Real[web:1] and invented[web:9].'),
    );
    const answer = await perplexityEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.citations).toHaveLength(1);
  });

  // A repeated marker and two ids pointing at the same exact URL are the same
  // document, so they collapse — but `sources` is every consulted result, cited
  // or not, so both entries survive there.
  it('a repeated marker and two ids resolving to the same URL collapse to one citation', async () => {
    const rec = makeRecordingFetch(
      fixtureWith(
        [
          { id: 1, url: 'https://same.example/p', title: 'Same' },
          { id: 2, url: 'https://same.example/p', title: 'Same again' },
        ],
        'A[web:1] B[web:1] C[web:2].',
      ),
    );
    const answer = await perplexityEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.citations).toHaveLength(1);
    expect(answer.citations[0]?.url).toBe('https://same.example/p');
    expect(answer.citations[0]?.position).toBe(1);
    expect(answer.sources).toHaveLength(2);
  });

  // URL identity is exact string equality — no trailing-slash, query-string or
  // fragment normalisation, because each can name a genuinely different
  // resource and collapsing them would be a guess dressed as precision.
  it('a trailing slash, a query string and a fragment each stay a separate citation', async () => {
    const rec = makeRecordingFetch(
      fixtureWith(
        [
          { id: 1, url: 'https://ex.example/p' },
          { id: 2, url: 'https://ex.example/p/' },
          { id: 3, url: 'https://ex.example/p?page=2' },
          { id: 4, url: 'https://ex.example/p#frag' },
        ],
        'One[web:1] two[web:2] three[web:3] four[web:4].',
      ),
    );
    const answer = await perplexityEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.citations).toHaveLength(4);
    expect(answer.citations.map((c) => c.position)).toEqual([1, 2, 3, 4]);
  });

  it('caps citations at maxCitations', async () => {
    const rec = makeRecordingFetch(
      fixtureWith(
        [
          { id: 1, url: 'https://ex.example/p' },
          { id: 2, url: 'https://ex.example/p/' },
          { id: 3, url: 'https://ex.example/p?page=2' },
          { id: 4, url: 'https://ex.example/p#frag' },
        ],
        'One[web:1] two[web:2] three[web:3] four[web:4].',
      ),
    );
    const answer = await perplexityEngine.ask(
      req({ maxCitations: 2 }),
      makeCtx(rec.scopedFetch),
      REF,
    );
    expect(answer.citations).toHaveLength(2);
    expect(answer.citations.map((c) => c.position)).toEqual([1, 2]);
    expect(answer.citations.map((c) => c.url)).toEqual([
      'https://ex.example/p',
      'https://ex.example/p/',
    ]);
  });

  // FIRST-ID-WINS: two `search_results` items can reuse an id, and preferring
  // the later one would be a guess dressed as precision. With no
  // `tool_calls_details` in the body, `searchCalls` falls back to the item count.
  it('two search_results items reusing an id: first wins, searchCalls falls back to item count', async () => {
    const rec = makeRecordingFetch({
      id: 'resp_3',
      object: 'response',
      status: 'completed',
      model: 'openai/gpt-5.6-luna',
      output: [
        {
          type: 'search_results',
          queries: ['a'],
          results: [{ id: 1, url: 'https://first.example/a', title: 'First' }],
        },
        {
          type: 'search_results',
          queries: ['b'],
          results: [{ id: 1, url: 'https://second.example/b', title: 'Second' }],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Only one[web:1].', annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    });
    const answer = await perplexityEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.citations).toHaveLength(1);
    expect(answer.citations[0]?.url).toBe('https://first.example/a');
    expect(answer.citations[0]?.title).toBe('First');
    expect(answer.searchCalls).toBe(2);
    expect(answer.sources).toHaveLength(2);
    expect(answer.searched).toBe(true);
  });

  it('no search_results item: searched false, searchCalls 0, sources and citations empty', async () => {
    const rec = makeRecordingFetch({
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Answered from memory.', annotations: [] }],
        },
      ],
      usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
    });
    const answer = await perplexityEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.searched).toBe(false);
    expect(answer.searchCalls).toBe(0);
    expect(answer.sources).toEqual([]);
    expect(answer.citations).toEqual([]);
    expect(answer.answerText).toBe('Answered from memory.');
  });

  // The `low` preset enables the `fetch_url` tool, so a `fetch_url_results`
  // item is routine, not hypothetical — and it contributes nothing to sources.
  it('unknown output item types are skipped and never fatal', async () => {
    const rec = makeRecordingFetch({
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'thinking' }] },
        {
          type: 'fetch_url_results',
          results: [{ id: 99, url: 'https://fetched.example/z', title: 'Fetched' }],
        },
        {
          type: 'search_results',
          queries: ['q'],
          results: [{ id: 1, url: 'https://ok.example/a', title: 'OK' }],
        },
        { type: 'future_item_type', payload: { anything: true } },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Fine[web:1].', annotations: [] }],
        },
      ],
    });
    const answer = await perplexityEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.answerText).toBe('Fine[web:1].');
    expect(answer.citations).toHaveLength(1);
    expect(answer.citations[0]?.url).toBe('https://ok.example/a');
    expect(answer.sources).toEqual([{ url: 'https://ok.example/a', domain: 'ok.example' }]);
  });

  it('a body whose usage omits the token fields yields no usage on the record', async () => {
    const rec = makeRecordingFetch({
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Answered from memory.', annotations: [] }],
        },
      ],
      usage: { total_tokens: 9 },
    });
    const answer = await perplexityEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.usage).toBeUndefined();
  });

  it('searchCalls prefers usage.tool_calls_details.search_web.invocation over the item count', async () => {
    const rec = makeRecordingFetch({
      output: [
        {
          type: 'search_results',
          queries: ['q'],
          results: [{ id: 1, url: 'https://ok.example/a', title: 'OK' }],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Fine[web:1].', annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        tool_calls_details: { search_web: { invocation: 4 } },
      },
    });
    const answer = await perplexityEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.searchCalls).toBe(4);
  });

  it('falls back to the requested preset only when the body names no model', async () => {
    const rec = makeRecordingFetch({ output: [] });
    const answer = await perplexityEngine.ask(
      req({ model: 'fast' }),
      makeCtx(rec.scopedFetch),
      REF,
    );
    expect(answer.model).toBe('fast');
  });

  it('joins multiple output_text parts with a blank line', async () => {
    const rec = makeRecordingFetch({
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'Part one.' },
            { type: 'refusal', refusal: 'nope' },
            { type: 'output_text', text: 'Part two.' },
          ],
        },
      ],
    });
    const answer = await perplexityEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.answerText).toBe('Part one.\n\nPart two.');
  });

  it('carries country onto the record when given', async () => {
    const rec = makeRecordingFetch(baseFixture);
    const answer = await perplexityEngine.ask(
      req({ country: 'IN' }),
      makeCtx(rec.scopedFetch),
      REF,
    );
    expect(answer.country).toBe('IN');
  });

  it('askedAt is an ISO timestamp taken around the request', async () => {
    const before = Date.now();
    const rec = makeRecordingFetch(baseFixture);
    const answer = await perplexityEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    const t = Date.parse(answer.askedAt);
    expect(Number.isNaN(t)).toBe(false);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });
});

describe('perplexity engine — failures', () => {
  it('non-2xx throws EngineHttpError with the status and the body cut to 500 characters', async () => {
    const rec = makeRecordingFetch('z'.repeat(2000), 500);
    const err: unknown = await perplexityEngine
      .ask(req(), makeCtx(rec.scopedFetch), REF)
      .catch((e) => e);
    if (!(err instanceof EngineHttpError)) throw new Error('expected EngineHttpError');
    expect(err.status).toBe(500);
    expect(err.message.startsWith('Perplexity API error')).toBe(true);
    expect(err.message).toContain('500');
    expect(err.message.match(/z+/)?.[0]).toHaveLength(500);
  });

  it('throws EngineNoKeyError before any network call when the ref resolves to nothing', async () => {
    const rec = makeRecordingFetch(baseFixture);
    await expect(
      perplexityEngine.ask(req(), makeCtx(rec.scopedFetch, { get: async () => '' }), REF),
    ).rejects.toBeInstanceOf(EngineNoKeyError);
    expect(rec.calls).toHaveLength(0);
  });
});
