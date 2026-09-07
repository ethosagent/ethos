import type { ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { chatgptEngine } from '../engines/chatgpt';
import { EngineHttpError, EngineNoKeyError, type EngineRequest } from '../engines/types';

// ---------------------------------------------------------------------------
// Fixtures — mirrors extensions/tools-x-search/src/__tests__/x-search.test.ts:
// plain-object secretsResolver/scopedFetch stubs, a recording fetch, never a
// live network call. Response shapes follow the OpenAI web_search docs as
// read on 2026-09-07 (plan §3); M3 adds a recorded real response.
// ---------------------------------------------------------------------------

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
    query: 'What are the best travel credit cards in India?',
    model: 'gpt-test',
    searchContextSize: 'medium',
    requireSearch: false,
    maxCitations: 20,
    ...overrides,
  };
}

const REF = 'providers/openai/apiKey';

/** Two web_search_call items (one with action.sources) + one message with three url_citations, two sharing a URL. */
const twoSearchFixture = {
  id: 'resp_1',
  object: 'response',
  model: 'gpt-5.5-2026-08-01',
  output: [
    {
      type: 'web_search_call',
      id: 'ws_1',
      status: 'completed',
      action: {
        type: 'search',
        query: 'best travel credit cards india',
        sources: [{ url: 'https://www.cardexpert.in/best' }, 'https://paisabazaar.com/cards'],
      },
    },
    { type: 'reasoning', id: 'rs_1', summary: [] },
    {
      type: 'web_search_call',
      id: 'ws_2',
      status: 'completed',
      action: { type: 'open_page', url: 'https://www.cardexpert.in/best' },
    },
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: 'Axis Atlas leads, then HDFC Infinia. Amex Platinum Travel is third.',
          annotations: [
            {
              type: 'url_citation',
              url: 'https://www.Paisabazaar.com/cards',
              title: 'Paisabazaar',
              start_index: 40,
              end_index: 60,
            },
            {
              type: 'url_citation',
              url: 'https://www.cardexpert.in/best',
              title: 'CardExpert',
              start_index: 0,
              end_index: 16,
            },
            {
              type: 'url_citation',
              url: 'https://www.cardexpert.in/best',
              title: 'CardExpert again',
              start_index: 20,
              end_index: 35,
            },
          ],
        },
      ],
    },
  ],
  usage: { input_tokens: 1200, output_tokens: 340, total_tokens: 1540 },
};

describe('chatgpt engine — identity', () => {
  it('declares id, host, secret prefix and default ref', () => {
    expect(chatgptEngine.id).toBe('chatgpt');
    expect(chatgptEngine.host).toBe('api.openai.com');
    expect(chatgptEngine.secretPrefix).toBe('providers/openai/');
    expect(chatgptEngine.defaultSecretRef).toBe('providers/openai/apiKey');
  });
});

describe('chatgpt engine — request body', () => {
  it('POSTs the question as the entire input, with web_search, include and store:false', async () => {
    const rec = makeRecordingFetch(twoSearchFixture);
    await chatgptEngine.ask(req({ model: 'gpt-requested' }), makeCtx(rec.scopedFetch), REF);

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.url).toBe('https://api.openai.com/v1/responses');
    expect(rec.calls[0]?.init?.method).toBe('POST');
    expect(new Headers(rec.calls[0]?.init?.headers).get('Authorization')).toBe(
      'Bearer test-api-key',
    );
    const body = JSON.parse(String(rec.calls[0]?.init?.body));
    expect(body.model).toBe('gpt-requested');
    expect(body.input).toBe('What are the best travel credit cards in India?');
    expect(body.tools).toEqual([{ type: 'web_search', search_context_size: 'medium' }]);
    expect(body.tool_choice).toBe('auto');
    expect(body.include).toEqual(['web_search_call.action.sources']);
    expect(body.store).toBe(false);
    expect('instructions' in body).toBe(false);
    expect('user_location' in body.tools[0]).toBe(false);
  });

  it('adds user_location only when country is set, and forwards search_context_size', async () => {
    const rec = makeRecordingFetch(twoSearchFixture);
    await chatgptEngine.ask(
      req({ country: 'IN', searchContextSize: 'high' }),
      makeCtx(rec.scopedFetch),
      REF,
    );
    const body = JSON.parse(String(rec.calls[0]?.init?.body));
    expect(body.tools[0]).toEqual({
      type: 'web_search',
      search_context_size: 'high',
      user_location: { type: 'approximate', country: 'IN' },
    });
  });

  it('tool_choice follows requireSearch', async () => {
    const rec = makeRecordingFetch(twoSearchFixture);
    await chatgptEngine.ask(req({ requireSearch: true }), makeCtx(rec.scopedFetch), REF);
    expect(JSON.parse(String(rec.calls[0]?.init?.body)).tool_choice).toBe('required');
  });

  it('threads ctx.abortSignal into the fetch', async () => {
    const rec = makeRecordingFetch(twoSearchFixture);
    const ctx = makeCtx(rec.scopedFetch);
    await chatgptEngine.ask(req(), ctx, REF);
    expect(rec.calls[0]?.init?.signal).toBe(ctx.abortSignal);
  });

  it('resolves the key through the given secretRef, never a hardcoded one', async () => {
    const rec = makeRecordingFetch(twoSearchFixture);
    const refs: string[] = [];
    const secrets = {
      get: async (ref: string) => {
        refs.push(ref);
        return 'bound-key';
      },
    };
    await chatgptEngine.ask(req(), makeCtx(rec.scopedFetch, secrets), 'providers/openai/brand');
    expect(refs).toEqual(['providers/openai/brand']);
    expect(new Headers(rec.calls[0]?.init?.headers).get('Authorization')).toBe('Bearer bound-key');
  });
});

describe('chatgpt engine — response parsing', () => {
  it('two web_search_call items + one message: searched, ordered de-duplicated citations, sources', async () => {
    const rec = makeRecordingFetch(twoSearchFixture);
    const answer = await chatgptEngine.ask(req(), makeCtx(rec.scopedFetch), REF);

    expect(answer.engine).toBe('chatgpt');
    expect(answer.searched).toBe(true);
    expect(answer.searchCalls).toBe(2);
    expect(answer.answerText).toBe(
      'Axis Atlas leads, then HDFC Infinia. Amex Platinum Travel is third.',
    );
    // Ordered by start_index (0, 20, 40); the start_index 20 entry repeats the
    // start_index 0 URL and collapses into it; positions are sequential after.
    expect(answer.citations).toEqual([
      {
        url: 'https://www.cardexpert.in/best',
        title: 'CardExpert',
        domain: 'cardexpert.in',
        position: 1,
      },
      {
        url: 'https://www.Paisabazaar.com/cards',
        title: 'Paisabazaar',
        domain: 'paisabazaar.com',
        position: 2,
      },
    ]);
    // action.sources accepted as { url } objects and as plain strings.
    expect(answer.sources).toEqual([
      { url: 'https://www.cardexpert.in/best', domain: 'cardexpert.in' },
      { url: 'https://paisabazaar.com/cards', domain: 'paisabazaar.com' },
    ]);
    expect(answer.usage).toEqual({ inputTokens: 1200, outputTokens: 340 });
    expect(answer.query).toBe('What are the best travel credit cards in India?');
    expect(answer.country).toBeUndefined();
    expect(answer.truncated).toBeUndefined();
  });

  it('model comes from the response, not the request', async () => {
    const rec = makeRecordingFetch(twoSearchFixture);
    const answer = await chatgptEngine.ask(
      req({ model: 'gpt-requested' }),
      makeCtx(rec.scopedFetch),
      REF,
    );
    expect(answer.model).toBe('gpt-5.5-2026-08-01');
  });

  it('falls back to the requested model only when the body names none', async () => {
    const rec = makeRecordingFetch({ output: [] });
    const answer = await chatgptEngine.ask(
      req({ model: 'gpt-requested' }),
      makeCtx(rec.scopedFetch),
      REF,
    );
    expect(answer.model).toBe('gpt-requested');
  });

  it('no web_search_call: searched false, sources empty, usage absent when incomplete', async () => {
    const rec = makeRecordingFetch({
      model: 'gpt-5.5',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'From memory.', annotations: [] }],
        },
      ],
      usage: { input_tokens: 10 },
    });
    const answer = await chatgptEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.searched).toBe(false);
    expect(answer.searchCalls).toBe(0);
    expect(answer.sources).toEqual([]);
    expect(answer.citations).toEqual([]);
    expect(answer.answerText).toBe('From memory.');
    expect(answer.usage).toBeUndefined();
  });

  it('unknown output item types and non-url_citation annotations are ignored', async () => {
    const rec = makeRecordingFetch({
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] },
        { type: 'future_item_type', payload: { anything: true } },
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'refusal', refusal: 'nope' },
            {
              type: 'output_text',
              text: 'Part one.',
              annotations: [{ type: 'file_citation', file_id: 'f1', index: 2 }],
            },
            { type: 'output_text', text: 'Part two.' },
          ],
        },
      ],
    });
    const answer = await chatgptEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.answerText).toBe('Part one.\n\nPart two.');
    expect(answer.citations).toEqual([]);
    expect(answer.searched).toBe(false);
  });

  it('orders citations across multiple output_text parts by their place in the joined text', async () => {
    const rec = makeRecordingFetch({
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'First part.',
              annotations: [{ type: 'url_citation', url: 'https://a.example/1', start_index: 5 }],
            },
            {
              type: 'output_text',
              text: 'Second part.',
              annotations: [{ type: 'url_citation', url: 'https://b.example/2', start_index: 0 }],
            },
          ],
        },
      ],
    });
    const answer = await chatgptEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.citations.map((c) => c.url)).toEqual([
      'https://a.example/1',
      'https://b.example/2',
    ]);
    expect(answer.citations[0]?.title).toBeUndefined();
  });

  it('caps citations at maxCitations after de-duplication', async () => {
    const annotations = Array.from({ length: 8 }, (_, i) => ({
      type: 'url_citation',
      url: `https://site${i % 6}.example/p`,
      start_index: i,
      end_index: i + 1,
    }));
    const rec = makeRecordingFetch({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'x', annotations }] }],
    });
    const answer = await chatgptEngine.ask(req({ maxCitations: 3 }), makeCtx(rec.scopedFetch), REF);
    expect(answer.citations.map((c) => c.position)).toEqual([1, 2, 3]);
    expect(answer.citations.map((c) => c.domain)).toEqual([
      'site0.example',
      'site1.example',
      'site2.example',
    ]);
  });

  it('skips citations and sources whose URL does not parse', async () => {
    const rec = makeRecordingFetch({
      output: [
        { type: 'web_search_call', action: { type: 'search', sources: ['not a url', 42, null] } },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'x',
              annotations: [
                { type: 'url_citation', url: 'garbage', start_index: 0 },
                { type: 'url_citation', url: 'https://ok.example/', start_index: 1 },
              ],
            },
          ],
        },
      ],
    });
    const answer = await chatgptEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.sources).toEqual([]);
    expect(answer.citations).toEqual([
      { url: 'https://ok.example/', domain: 'ok.example', position: 1 },
    ]);
  });

  it('askedAt is an ISO timestamp taken around the request', async () => {
    const before = Date.now();
    const rec = makeRecordingFetch(twoSearchFixture);
    const answer = await chatgptEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    const t = Date.parse(answer.askedAt);
    expect(Number.isNaN(t)).toBe(false);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });

  it('carries country onto the record when given', async () => {
    const rec = makeRecordingFetch(twoSearchFixture);
    const answer = await chatgptEngine.ask(req({ country: 'IN' }), makeCtx(rec.scopedFetch), REF);
    expect(answer.country).toBe('IN');
  });
});

describe('chatgpt engine — failures', () => {
  it('throws EngineNoKeyError before any network call when the ref resolves to nothing', async () => {
    const rec = makeRecordingFetch(twoSearchFixture);
    await expect(
      chatgptEngine.ask(req(), makeCtx(rec.scopedFetch, { get: async () => '' }), REF),
    ).rejects.toBeInstanceOf(EngineNoKeyError);
    expect(rec.calls).toHaveLength(0);
  });

  it('throws when scopedFetch is absent', async () => {
    const ctx = makeCtx(makeRecordingFetch({}).scopedFetch);
    const { scopedFetch: _omitted, ...withoutFetch } = ctx;
    await expect(chatgptEngine.ask(req(), withoutFetch, REF)).rejects.toThrow(/scopedFetch/);
  });

  it('non-2xx throws EngineHttpError with the status and the body cut to 500 characters', async () => {
    const rec = makeRecordingFetch('z'.repeat(2000), 500);
    const err = await chatgptEngine.ask(req(), makeCtx(rec.scopedFetch), REF).catch((e) => e);
    expect(err).toBeInstanceOf(EngineHttpError);
    expect(err.status).toBe(500);
    expect(err.message).toContain('500');
    expect(err.message.match(/z+/)?.[0]).toHaveLength(500);
  });
});
