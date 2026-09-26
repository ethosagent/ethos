import type { ToolContext } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { geminiEngine } from '../engines/gemini';
import { secretGrantsOf } from '../engines/roster';
import { EngineHttpError, EngineNoKeyError, type EngineRequest } from '../engines/types';
import { createEngineAskTool } from '../index';
import { GEMINI_RECORDED } from './fixtures/gemini.recorded';

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
    model: 'gemini-3.8-flash',
    searchContextSize: 'medium',
    requireSearch: false,
    maxCitations: 20,
    ...overrides,
  };
}

const REF = 'providers/gemini/apiKey';
const bodyOf = (call: { init?: RequestInit } | undefined) => JSON.parse(String(call?.init?.body));

/** A single model_output step carrying `text` and the given annotations. */
function outputWith(text: string, annotations: unknown[], extraSteps: unknown[] = []) {
  return {
    model: 'gemini-3.8-flash',
    steps: [
      ...extraSteps,
      { type: 'model_output', content: [{ type: 'text', text, annotations }] },
    ],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gemini engine — identity', () => {
  it('declares id, label, host, namespace grant, supports, default model and env var', () => {
    expect(geminiEngine.id).toBe('gemini');
    expect(geminiEngine.label).toBe('Google');
    expect(geminiEngine.hosts).toEqual(['generativelanguage.googleapis.com']);
    expect(geminiEngine.defaultSecretRef).toBe('providers/gemini/apiKey');
    expect(geminiEngine.bindable).toBe(true);
    expect(secretGrantsOf(geminiEngine)).toEqual(['providers/gemini/*']);
    expect(geminiEngine.getKeyUrl).toBe('https://aistudio.google.com/apikey');
    expect(geminiEngine.supports).toEqual({
      country: false,
      searchContextSize: false,
      requireSearch: false,
    });
    expect(geminiEngine.defaultModel).toBe('gemini-3.8-flash');
    expect(geminiEngine.modelEnvVar).toBe('GEMINI_ANSWER_ENGINE_MODEL');
  });
});

describe('gemini engine — request', () => {
  it('POSTs the query verbatim, google_search and store:false — and nothing optional, even when given', async () => {
    const rec = makeRecordingFetch(GEMINI_RECORDED);
    await geminiEngine.ask(
      req({ country: 'IN', searchContextSize: 'high', requireSearch: true }),
      makeCtx(rec.scopedFetch),
      REF,
    );
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(bodyOf(rec.calls[0])).toEqual({
      model: 'gemini-3.8-flash',
      input: 'Which Indian banks offer the best travel credit cards?',
      tools: [{ type: 'google_search' }],
      store: false,
    });
  });

  it('sends x-goog-api-key and Api-Revision: 2026-05-20, and no Authorization header', async () => {
    const rec = makeRecordingFetch(GEMINI_RECORDED);
    await geminiEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    const headers = new Headers(rec.calls[0]?.init?.headers);
    expect(headers.get('x-goog-api-key')).toBe('test-api-key');
    expect(headers.get('Api-Revision')).toBe('2026-05-20');
    expect(headers.get('Authorization')).toBeNull();
  });

  it('threads ctx.abortSignal and goes through ctx.scopedFetch only', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const rec = makeRecordingFetch(GEMINI_RECORDED);
    const ctx = makeCtx(rec.scopedFetch);
    await geminiEngine.ask(req(), ctx, REF);
    expect(rec.calls[0]?.init?.signal).toBe(ctx.abortSignal);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('gemini engine — response parsing', () => {
  it('parses the recorded-shape fixture', async () => {
    const rec = makeRecordingFetch(GEMINI_RECORDED);
    const answer = await geminiEngine.ask(req({ country: 'IN' }), makeCtx(rec.scopedFetch), REF);
    expect(answer).toMatchObject({
      engine: 'gemini',
      model: 'gemini-3.8-flash',
      searched: true,
      // One google_search_call STEP carrying two queries: the step count, not
      // the (billed) query count.
      searchCalls: 1,
      usage: { inputTokens: 1830, outputTokens: 96 },
      sources: [],
    });
    expect(answer.country).toBeUndefined();
    expect(answer.citations).toEqual([
      { url: 'https://www.cardexpert.in/axis-atlas-review/', domain: 'cardexpert.in', position: 1 },
      { url: 'https://www.hdfcbank.com/infinia', domain: 'hdfcbank.com', position: 2 },
    ]);
  });

  // D11. Two text parts. Citation B sits near the END of the first part, which
  // is Devanagari, a rupee sign and an emoji; citation A at the START of the
  // second. Offsets are joined across parts, so A's joined offset is "length
  // of part one + 2" — in BYTES that is past B, in UTF-16 units it is NOT
  // (asserted below by construction), so an adapter that measured part one in
  // UTF-16 would put A first and fail this test.
  it('byte offsets: orders a non-ASCII answer by bytes, which a UTF-16 reading would get wrong', async () => {
    const first = 'भारत में सबसे अच्छा ट्रैवल कार्ड ₹ 🎉 Atlas';
    const second = 'Infinia follows.';
    const enc = new TextEncoder();
    const bBytes = enc.encode(first.slice(0, first.indexOf('Atlas'))).length;
    // The construction: B's byte offset lies beyond part one's UTF-16 length.
    expect(bBytes).toBeGreaterThan(first.length + 2);
    const rec = makeRecordingFetch({
      model: 'gemini-3.8-flash',
      steps: [
        {
          type: 'model_output',
          content: [
            {
              type: 'text',
              text: first,
              annotations: [
                { type: 'url_citation', url: 'https://b.example/', start_index: bBytes },
              ],
            },
            {
              type: 'text',
              text: second,
              annotations: [{ type: 'url_citation', url: 'https://a.example/', start_index: 0 }],
            },
          ],
        },
      ],
    });
    const answer = await geminiEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.citations.map((c) => c.url)).toEqual([
      'https://b.example/',
      'https://a.example/',
    ]);
    // Returned verbatim — never sliced by these offsets.
    expect(answer.answerText).toBe(`${first}\n\n${second}`);
  });

  it('citations[].title is undefined even though every annotation carries a bare domain', async () => {
    const rec = makeRecordingFetch(GEMINI_RECORDED);
    const answer = await geminiEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.citations.length).toBeGreaterThan(0);
    for (const c of answer.citations) {
      expect(c.title).toBeUndefined();
      expect(c.domain).toBe(new URL(c.url).hostname.replace(/^www\./, ''));
    }
  });

  it('sources: empty for a google_search_result with no result[], populated when it has one', async () => {
    const empty = makeRecordingFetch(
      outputWith('A.', [], [{ type: 'google_search_result', call_id: 'x' }]),
    );
    expect((await geminiEngine.ask(req(), makeCtx(empty.scopedFetch), REF)).sources).toEqual([]);

    const full = makeRecordingFetch(
      outputWith(
        'A.',
        [],
        [
          {
            type: 'google_search_result',
            result: [
              { title: 'Card', url: 'https://www.card.example/x', snippet: 's' },
              { title: 'no url' },
              'https://not-an-object.example/',
            ],
          },
        ],
      ),
    );
    expect((await geminiEngine.ask(req(), makeCtx(full.scopedFetch), REF)).sources).toEqual([
      { url: 'https://www.card.example/x', domain: 'card.example' },
    ]);
  });

  it('searchCalls is the google_search_call step count: three queries across two calls → 2', async () => {
    const rec = makeRecordingFetch(
      outputWith(
        'A.',
        [],
        [
          { type: 'google_search_call', arguments: { queries: ['a', 'b'] } },
          { type: 'google_search_call', arguments: { queries: ['c'] } },
        ],
      ),
    );
    const answer = await geminiEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.searchCalls).toBe(2);
    expect(answer.searched).toBe(true);
  });

  it('thought and unknown steps are skipped, never fatal; parts join with a blank line', async () => {
    const rec = makeRecordingFetch({
      steps: [
        { type: 'thought', signature: 'x' },
        { type: 'future_step', anything: true },
        null,
        {
          type: 'model_output',
          content: [
            { type: 'text', text: 'One.' },
            { type: 'image', data: '…' },
            { type: 'text', text: 'Two.' },
          ],
        },
      ],
    });
    const answer = await geminiEngine.ask(req(), makeCtx(rec.scopedFetch), REF);
    expect(answer.answerText).toBe('One.\n\nTwo.');
    expect(answer.searched).toBe(false);
    expect(answer.model).toBe('gemini-3.8-flash');
    expect(answer.usage).toBeUndefined();
  });
});

describe('gemini engine — failures', () => {
  it('an empty ref throws EngineNoKeyError before any network call', async () => {
    const rec = makeRecordingFetch(GEMINI_RECORDED);
    await expect(
      geminiEngine.ask(req(), makeCtx(rec.scopedFetch, { get: async () => '' }), REF),
    ).rejects.toBeInstanceOf(EngineNoKeyError);
    expect(rec.calls).toHaveLength(0);
  });

  it('a non-2xx throws EngineHttpError labelled Google', async () => {
    const rec = makeRecordingFetch({ error: { message: 'quota' } }, 429);
    const err: unknown = await geminiEngine
      .ask(req(), makeCtx(rec.scopedFetch), REF)
      .catch((e) => e);
    if (!(err instanceof EngineHttpError)) throw new Error('expected EngineHttpError');
    expect(err.message.startsWith('Google API error 429')).toBe(true);
  });

  it('through the tool: an empty resolve and a 401 both → not_available naming Settings → Keys and GEMINI_API_KEY', async () => {
    const tool = createEngineAskTool();
    const recEmpty = makeRecordingFetch(GEMINI_RECORDED);
    const rec401 = makeRecordingFetch({ error: { message: 'API key not valid' } }, 401);
    const results = [
      await tool.execute(
        { query: 'q', engine: 'gemini' },
        makeCtx(recEmpty.scopedFetch, { get: async () => '' }),
      ),
      await tool.execute({ query: 'q', engine: 'gemini' }, makeCtx(rec401.scopedFetch)),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('not_available');
        expect(result.error).toContain('Settings → Keys');
        expect(result.error).toContain('GEMINI_API_KEY');
      }
    }
    expect(recEmpty.calls).toHaveLength(0);
  });
});
