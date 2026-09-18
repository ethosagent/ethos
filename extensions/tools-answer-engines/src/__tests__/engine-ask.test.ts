import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineAnswer } from '../engines/types';
import { ANSWER_TEXT_FLOOR, renderJson } from '../format';
import { createEngineAskTool, engineAskTool } from '../index';

// ---------------------------------------------------------------------------
// Fixtures — mirrors extensions/tools-x-search/src/__tests__/x-search.test.ts's
// mockSecrets/mockFetch/ctx conventions (plain-object ScopedSecretsResolver +
// ScopedFetch stubs, never a real network call).
// ---------------------------------------------------------------------------

const mockSecrets = {
  get: async (_ref: string) => 'test-api-key',
};

type ScopedFetchLike = {
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
};

const mockFetch: ScopedFetchLike = {
  fetch: async (_url, _init) => new Response('OK', { status: 200 }),
};

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

function makeRecordingFetch(responseBody: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: typeof url === 'string' ? url : url.toString(), init });
    const body = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
  return { scopedFetch: { fetch }, calls };
}

function ctxWith(scopedFetch: ScopedFetchLike, secrets = mockSecrets) {
  return { ...ctx, scopedFetch, secretsResolver: secrets };
}

/** A searched answer with `n` distinct citations and the given text. */
function answerBody(text: string, n = 2) {
  return {
    model: 'gpt-5.5-2026-08-01',
    output: [
      {
        type: 'web_search_call',
        action: { type: 'search', sources: [{ url: 'https://s.example/' }] },
      },
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text,
            annotations: Array.from({ length: n }, (_, i) => ({
              type: 'url_citation',
              url: `https://www.site${i}.example/page`,
              title: i === 0 ? 'Site zero' : undefined,
              start_index: i,
              end_index: i + 1,
            })),
          },
        ],
      },
    ],
    usage: { input_tokens: 5, output_tokens: 7 },
  };
}

/** A searched Perplexity Agent API answer with `n` distinct results, cited by `[web:N]` markers in `text`. */
function perplexityBody(text: string, n = 2) {
  return {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    model: 'openai/gpt-5.6-luna',
    output: [
      {
        type: 'search_results',
        queries: ['q'],
        results: Array.from({ length: n }, (_, i) => ({
          id: i + 1,
          url: `https://www.site${i}.example/page`,
          title: `Site ${i}`,
          snippet: 'snippet',
          date: '2026-05-01',
          last_updated: '2026-05-02',
          source: 'web',
        })),
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 5,
      output_tokens: 7,
      total_tokens: 12,
      tool_calls_details: { search_web: { invocation: 1 } },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('engine_ask — availability', () => {
  it('isAvailable always returns true, regardless of key presence', () => {
    expect(engineAskTool.isAvailable?.()).toBe(true);
    const noKey = createEngineAskTool({ resolvePersonalitySetting: () => ({ secret: 'none' }) });
    expect(noKey.isAvailable?.()).toBe(true);
  });

  it('returns not_available when capability backends are missing', async () => {
    const result = await engineAskTool.execute({ query: 'test' }, ctxWithoutCapabilities);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toBe('Capability backends not configured');
    }
  });

  it('returns not_available when only scopedFetch is present', async () => {
    const result = await engineAskTool.execute(
      { query: 'test' },
      { ...ctxWithoutCapabilities, scopedFetch: mockFetch },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });
});

describe('engine_ask — input validation', () => {
  it('returns input_invalid if query is missing', async () => {
    const result = await engineAskTool.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('rejects an engine outside the roster, before any network call', async () => {
    const rec = makeRecordingFetch({});
    const result = await engineAskTool.execute(
      { query: 'q', engine: 'gemini' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('input_invalid');
      expect(result.error).toContain('chatgpt');
    }
    expect(rec.calls).toHaveLength(0);
  });

  it('rejects a country that is not two upper-case letters', async () => {
    const rec = makeRecordingFetch({});
    for (const country of ['in', 'IND', 'I1', '']) {
      const result = await engineAskTool.execute({ query: 'q', country }, ctxWith(rec.scopedFetch));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('input_invalid');
    }
    expect(rec.calls).toHaveLength(0);
  });

  it('rejects a format outside text|json', async () => {
    const rec = makeRecordingFetch({});
    const result = await engineAskTool.execute(
      { query: 'q', format: 'yaml' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
    expect(rec.calls).toHaveLength(0);
  });

  it('rejects a search_context_size outside low|medium|high', async () => {
    const rec = makeRecordingFetch({});
    const result = await engineAskTool.execute(
      { query: 'q', search_context_size: 'huge' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
    expect(rec.calls).toHaveLength(0);
  });

  it('num_citations over 50 clamps to 50 rather than erroring', async () => {
    const rec = makeRecordingFetch(answerBody('A', 60));
    const result = await engineAskTool.execute(
      { query: 'q', num_citations: 1000, format: 'json' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.value).citations).toHaveLength(50);
  });

  it('num_citations defaults to 20', async () => {
    const rec = makeRecordingFetch(answerBody('A', 30));
    const result = await engineAskTool.execute(
      { query: 'q', format: 'json' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.value).citations).toHaveLength(20);
  });
});

describe('engine_ask — no key configured', () => {
  it('names the Named Secrets dialog and OPENAI_API_KEY, before any network call', async () => {
    const rec = makeRecordingFetch({});
    const noKeySecrets = { get: async (_ref: string) => '' };
    const result = await engineAskTool.execute(
      { query: 'q' },
      ctxWith(rec.scopedFetch, noKeySecrets),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toContain('Settings → Security → Named Secrets (provider OpenAI)');
      expect(result.error).toContain('OPENAI_API_KEY');
      expect(result.error).toContain('engine_ask');
    }
    expect(rec.calls).toHaveLength(0);
  });

  it('HTTP 401 is not_available with the same no-key message', async () => {
    const rec = makeRecordingFetch({ error: { message: 'Incorrect API key provided' } }, 401);
    const result = await engineAskTool.execute({ query: 'q' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toContain('OPENAI_API_KEY');
    }
  });

  it('an empty Perplexity ref yields not_available with a message that never mentions OpenAI', async () => {
    const rec = makeRecordingFetch({});
    const result = await engineAskTool.execute(
      { query: 'q', engine: 'perplexity' },
      ctxWith(rec.scopedFetch, { get: async (_ref: string) => '' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toContain('PERPLEXITY_API_KEY');
      expect(result.error).toContain('Settings → Keys (Perplexity)');
      expect(result.error).not.toContain('OpenAI');
      expect(result.error).not.toContain('OPENAI_API_KEY');
    }
    expect(rec.calls).toHaveLength(0);
  });

  it('a Perplexity HTTP 401 is not_available with the Perplexity no-key message', async () => {
    const rec = makeRecordingFetch({ error: { message: 'unauthorized' } }, 401);
    const result = await engineAskTool.execute(
      { query: 'q', engine: 'perplexity' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toContain('PERPLEXITY_API_KEY');
      expect(result.error).not.toContain('OPENAI_API_KEY');
    }
  });
});

describe('engine_ask — named-secret binding', () => {
  function makeRecordingSecrets(value = 'bound-key') {
    const refs: string[] = [];
    return {
      refs,
      get: async (ref: string) => {
        refs.push(ref);
        return value;
      },
    };
  }
  const withPersonality = (
    scopedFetch: ScopedFetchLike,
    secrets: typeof mockSecrets,
    pid: string,
  ) =>
    ({ ...ctxWith(scopedFetch, secrets), personalityId: pid }) as typeof ctx & {
      personalityId: string;
    };

  it('a bound secret NAME resolves providers/openai/<name>, never a value', async () => {
    const rec = makeRecordingFetch(answerBody('A'));
    const secrets = makeRecordingSecrets('super-secret');
    const tool = createEngineAskTool({
      resolvePersonalitySetting: (pid) =>
        pid === 'scout' ? { secret: 'openai-brand' } : undefined,
    });
    const result = await tool.execute(
      { query: 'q' },
      withPersonality(rec.scopedFetch, secrets, 'scout'),
    );
    expect(result.ok).toBe(true);
    expect(secrets.refs).toEqual(['providers/openai/openai-brand']);
    expect(new Headers(rec.calls[0]?.init?.headers).get('Authorization')).toBe(
      'Bearer super-secret',
    );
  });

  it('personality tools.yaml wins over global toolSettings[pid] and _default', async () => {
    const rec = makeRecordingFetch(answerBody('A'));
    const secrets = makeRecordingSecrets();
    const tool = createEngineAskTool({
      resolvePersonalitySetting: () => ({ secret: 'from-file' }),
      toolSettings: {
        scout: { engine_ask: { secret: 'from-slot' } },
        _default: { engine_ask: { secret: 'from-default' } },
      },
    });
    await tool.execute({ query: 'q' }, withPersonality(rec.scopedFetch, secrets, 'scout'));
    expect(secrets.refs).toEqual(['providers/openai/from-file']);
  });

  it('falls through to toolSettings[pid], then _default', async () => {
    const rec = makeRecordingFetch(answerBody('A'));
    const secrets = makeRecordingSecrets();
    const tool = createEngineAskTool({
      resolvePersonalitySetting: () => undefined,
      toolSettings: {
        scout: { engine_ask: { secret: 'from-slot' } },
        _default: { engine_ask: { secret: 'from-default' } },
      },
    });
    await tool.execute({ query: 'q' }, withPersonality(rec.scopedFetch, secrets, 'scout'));
    await tool.execute({ query: 'q' }, withPersonality(rec.scopedFetch, secrets, 'other'));
    expect(secrets.refs).toEqual(['providers/openai/from-slot', 'providers/openai/from-default']);
  });

  it('no binding anywhere → the default providers/openai/apiKey', async () => {
    const rec = makeRecordingFetch(answerBody('A'));
    const secrets = makeRecordingSecrets();
    await createEngineAskTool().execute({ query: 'q' }, ctxWith(rec.scopedFetch, secrets));
    expect(secrets.refs).toEqual(['providers/openai/apiKey']);
  });

  it('an invalid secret name falls through to the next rung instead of escaping the prefix', async () => {
    const rec = makeRecordingFetch(answerBody('A'));
    const secrets = makeRecordingSecrets();
    const tool = createEngineAskTool({
      resolvePersonalitySetting: () => ({ secret: '../xai/apiKey' }),
      toolSettings: {
        scout: { engine_ask: { secret: 'has space' } },
        _default: { engine_ask: { secret: 'from-default' } },
      },
    });
    await tool.execute({ query: 'q' }, withPersonality(rec.scopedFetch, secrets, 'scout'));
    expect(secrets.refs).toEqual(['providers/openai/from-default']);

    const allInvalid = createEngineAskTool({
      resolvePersonalitySetting: () => ({ secret: 'a/b' }),
      toolSettings: { _default: { engine_ask: { secret: '' } } },
    });
    await allInvalid.execute({ query: 'q' }, withPersonality(rec.scopedFetch, secrets, 'scout'));
    expect(secrets.refs.at(-1)).toBe('providers/openai/apiKey');
  });

  it('with no binding anywhere, each engine resolves its OWN default secret ref', async () => {
    const tool = createEngineAskTool();
    const secrets = makeRecordingSecrets();
    const recPx = makeRecordingFetch(perplexityBody('A[web:1]'));
    await tool.execute({ query: 'q', engine: 'perplexity' }, ctxWith(recPx.scopedFetch, secrets));
    const recCg = makeRecordingFetch(answerBody('A'));
    await tool.execute({ query: 'q' }, ctxWith(recCg.scopedFetch, secrets));
    expect(secrets.refs).toEqual(['providers/perplexity/apiKey', 'providers/openai/apiKey']);
  });

  it('the engine_ask binding names the OpenAI key only: geo-analyst / brand-guide bound { secret: "openai-key" } still resolve providers/perplexity/apiKey on a Perplexity call, on all three rungs', async () => {
    // All three rungs are gated by the one `engine.id !== 'chatgpt'` branch, so
    // covering only the first would let the other two rot.
    const tools = [
      createEngineAskTool({ resolvePersonalitySetting: () => ({ secret: 'openai-key' }) }),
      createEngineAskTool({ toolSettings: { scout: { engine_ask: { secret: 'openai-key' } } } }),
      createEngineAskTool({ toolSettings: { _default: { engine_ask: { secret: 'openai-key' } } } }),
    ];
    for (const tool of tools) {
      const secrets = makeRecordingSecrets();
      const recCg = makeRecordingFetch(answerBody('A'));
      await tool.execute({ query: 'q' }, withPersonality(recCg.scopedFetch, secrets, 'scout'));
      const recPx = makeRecordingFetch(perplexityBody('A[web:1]'));
      await tool.execute(
        { query: 'q', engine: 'perplexity' },
        withPersonality(recPx.scopedFetch, secrets, 'scout'),
      );
      expect(secrets.refs).toEqual(['providers/openai/openai-key', 'providers/perplexity/apiKey']);
      expect(secrets.refs).not.toContain('providers/perplexity/openai-key');
    }
  });
});

describe('engine_ask — format: text', () => {
  it('contains the answer, the numbered sources and the footer with model and searched', async () => {
    const rec = makeRecordingFetch(answerBody('Axis Atlas leads.'));
    const result = await engineAskTool.execute({ query: 'cards?' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('Axis Atlas leads.');
    expect(result.value).toContain(
      'Sources:\n1. Site zero\n   https://www.site0.example/page\n2. https://www.site1.example/page',
    );
    const footer = result.value.split('\n\n').at(-1) ?? '';
    expect(footer).toMatch(/^chatgpt · gpt-5\.5-2026-08-01 · searched · \d{4}-\d{2}-\d{2}T/);
    expect(result.structured).toMatchObject({
      engine: 'chatgpt',
      model: 'gpt-5.5-2026-08-01',
      searched: true,
      answerText: 'Axis Atlas leads.',
    });
  });

  it('reports "not searched" when the engine answered from memory', async () => {
    const rec = makeRecordingFetch({
      model: 'gpt-5.5',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'From memory.' }] }],
    });
    const result = await engineAskTool.execute({ query: 'q' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('From memory.');
      expect(result.value).not.toContain('Sources:');
      expect(result.value).toContain('chatgpt · gpt-5.5 · not searched · ');
    }
  });

  it('an empty answer with no citations still returns a document with the footer', async () => {
    const rec = makeRecordingFetch({ model: 'gpt-5.5', output: [] });
    const result = await engineAskTool.execute({ query: 'silence?' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.value.startsWith(
          'No answer returned for: silence?\n\nchatgpt · gpt-5.5 · not searched · ',
        ),
      ).toBe(true);
    }
  });

  it('renders a Perplexity answer with a perplexity footer', async () => {
    const rec = makeRecordingFetch(
      perplexityBody('Axis Atlas leads[web:1], then HDFC Infinia[web:2].'),
    );
    const result = await engineAskTool.execute(
      { query: 'cards?', engine: 'perplexity' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('Axis Atlas leads[web:1], then HDFC Infinia[web:2].');
    const footer = result.value.split('\n\n').at(-1) ?? '';
    expect(footer).toMatch(/^perplexity · openai\/gpt-5\.6-luna · searched · \d{4}-\d{2}-\d{2}T/);
  });
});

describe('engine_ask — format: json', () => {
  it('value parses and deep-equals structured', async () => {
    const rec = makeRecordingFetch(answerBody('Axis Atlas leads.'));
    const result = await engineAskTool.execute(
      { query: 'cards?', country: 'IN', format: 'json' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.value);
    expect(parsed).toEqual(result.structured);
    expect(parsed).toMatchObject({
      engine: 'chatgpt',
      model: 'gpt-5.5-2026-08-01',
      query: 'cards?',
      country: 'IN',
      searched: true,
      searchCalls: 1,
      answerText: 'Axis Atlas leads.',
      sources: [{ url: 'https://s.example/', domain: 's.example' }],
      usage: { inputTokens: 5, outputTokens: 7 },
    });
    expect(parsed.citations[0]).toEqual({
      url: 'https://www.site0.example/page',
      title: 'Site zero',
      domain: 'site0.example',
      position: 1,
    });
    expect(parsed.truncated).toBeUndefined();
    expect(result.value).not.toContain('\n');
  });

  it('a 200 kB answer yields valid JSON under maxResultChars with truncated: true', async () => {
    const rec = makeRecordingFetch(answerBody('x'.repeat(200_000)));
    const result = await engineAskTool.execute(
      { query: 'q', format: 'json' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeLessThanOrEqual(engineAskTool.maxResultChars ?? 0);
    const parsed = JSON.parse(result.value);
    expect(parsed.truncated).toBe(true);
    // The runaway answer pays for itself: sources go first, then the text is
    // shortened (format.ts's ladder). EVERY citation survives — evidence is the
    // half of the document a caller cannot reconstruct.
    expect(parsed.citations).toHaveLength(2);
    expect(parsed.citations[0].position).toBe(1);
    expect(parsed.sources).toEqual([]);
    expect(parsed.answerText.length).toBeGreaterThan(20_000);
    expect(parsed).toEqual(result.structured);
  });

  it('citations alone larger than the budget are dropped whole, leaving valid JSON', async () => {
    // 50 citations of ~2 kB of URL each — 100 kB of citations with a one-line
    // answer. Nothing here can be fixed by shortening answerText.
    const annotations = Array.from({ length: 50 }, (_, i) => ({
      type: 'url_citation',
      url: `https://site${i}.example/${'p'.repeat(2000)}`,
      start_index: i,
      end_index: i + 1,
    }));
    const rec = makeRecordingFetch({
      model: 'gpt-5.5',
      output: [
        { type: 'web_search_call', action: { type: 'search', sources: [] } },
        { type: 'message', content: [{ type: 'output_text', text: 'Short answer.', annotations }] },
      ],
    });
    const result = await engineAskTool.execute(
      { query: 'q', format: 'json', num_citations: 50 },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeLessThanOrEqual(engineAskTool.maxResultChars ?? 0);
    const parsed = JSON.parse(result.value);
    expect(parsed.truncated).toBe(true);
    // Citations are the last droppable rung, so the earliest survive and stay
    // contiguous from position 1; the one-line answer is already at its floor.
    expect(parsed.answerText).toBe('Short answer.');
    expect(parsed.citations.length).toBeGreaterThan(0);
    expect(parsed.citations.length).toBeLessThan(50);
    expect(parsed.citations.map((c: { position: number }) => c.position)).toEqual(
      parsed.citations.map((_: unknown, i: number) => i + 1),
    );
    expect(parsed).toEqual(result.structured);
  });

  it('parks the answer at its floor and drops citations from there', async () => {
    // 100 kB of answer AND 50 x ~2 kB of citations: shortening the answer alone
    // cannot buy enough room, so the ladder stops at the floor and the trailing
    // citations pay the rest.
    const annotations = Array.from({ length: 50 }, (_, i) => ({
      type: 'url_citation',
      url: `https://site${i}.example/${'p'.repeat(2000)}`,
      start_index: i,
      end_index: i + 1,
    }));
    const rec = makeRecordingFetch({
      model: 'gpt-5.5',
      output: [
        { type: 'web_search_call', action: { type: 'search', sources: [] } },
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'y'.repeat(100_000), annotations }],
        },
      ],
    });
    const result = await engineAskTool.execute(
      { query: 'q', format: 'json', num_citations: 50 },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeLessThanOrEqual(engineAskTool.maxResultChars ?? 0);
    const parsed = JSON.parse(result.value);
    expect(parsed.truncated).toBe(true);
    expect(parsed.answerText).toBe('y'.repeat(ANSWER_TEXT_FLOOR));
    expect(parsed.citations.length).toBeGreaterThan(0);
    expect(parsed.citations.length).toBeLessThan(50);
    expect(parsed).toEqual(result.structured);
  });

  it('a query longer than the whole budget still yields a parseable document', async () => {
    const rec = makeRecordingFetch(answerBody('x'.repeat(50_000)));
    const result = await engineAskTool.execute(
      { query: 'q'.repeat(60_000), format: 'json' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeLessThanOrEqual(engineAskTool.maxResultChars ?? 0);
    const parsed = JSON.parse(result.value);
    expect(parsed.truncated).toBe(true);
    // The echoed query is the last rung: everything above it is exhausted first,
    // and only with citations gone does the answer go below its floor.
    expect(parsed.citations).toEqual([]);
    expect(parsed.answerText).toBe('');
    expect(parsed.query.length).toBeGreaterThan(0);
    expect(parsed.query.length).toBeLessThan(60_000);
  });

  it('an answer dense with quotes and newlines still fits and parses after truncation', async () => {
    const rec = makeRecordingFetch(answerBody('He said "hi"\n\\ tab\t'.repeat(10_000)));
    const result = await engineAskTool.execute(
      { query: 'q', format: 'json' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeLessThanOrEqual(28_000);
    const parsed = JSON.parse(result.value);
    expect(parsed.truncated).toBe(true);
    expect(parsed.answerText.startsWith('He said "hi"\n')).toBe(true);
  });

  it('an empty answer with no citations is still a document, not an error', async () => {
    const rec = makeRecordingFetch({ model: 'gpt-5.5', output: [] });
    const result = await engineAskTool.execute(
      { query: 'q', format: 'json' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.value)).toMatchObject({
        answerText: '',
        citations: [],
        sources: [],
        searched: false,
      });
    }
  });

  it('a Perplexity answer parses and deep-equals structured', async () => {
    const rec = makeRecordingFetch(perplexityBody('Axis Atlas leads[web:1].'));
    const result = await engineAskTool.execute(
      { query: 'cards?', engine: 'perplexity', format: 'json' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.value);
    expect(parsed).toEqual(result.structured);
    expect(parsed).toMatchObject({
      engine: 'perplexity',
      model: 'openai/gpt-5.6-luna',
      query: 'cards?',
      searched: true,
      searchCalls: 1,
      answerText: 'Axis Atlas leads[web:1].',
      usage: { inputTokens: 5, outputTokens: 7 },
    });
    expect(parsed.citations[0]).toEqual({
      url: 'https://www.site0.example/page',
      title: 'Site 0',
      domain: 'site0.example',
      position: 1,
    });
  });
});

describe('renderJson — reduction ladder', () => {
  /** A pathological answer: 150 kB of prose, 40 fat citations, 5 sources. */
  function oversized(): EngineAnswer {
    return {
      engine: 'chatgpt',
      model: 'gpt-5.5',
      query: 'q',
      askedAt: '2026-09-07T00:00:00.000Z',
      searched: true,
      searchCalls: 1,
      answerText: 'z'.repeat(150_000),
      citations: Array.from({ length: 40 }, (_, i) => ({
        url: `https://site${i}.example/${'p'.repeat(1000)}`,
        domain: `site${i}.example`,
        position: i + 1,
      })),
      sources: Array.from({ length: 5 }, (_, i) => ({
        url: `https://s${i}.example/`,
        domain: `s${i}.example`,
      })),
    };
  }

  it('never cuts the answer below its floor while a citation is still droppable', () => {
    for (const limit of [28_000, 20_000, 10_000, 6_000]) {
      const { value, answer } = renderJson(oversized(), limit);
      expect(value.length).toBeLessThanOrEqual(limit);
      expect(JSON.parse(value)).toEqual(answer);
      expect(answer.sources).toEqual([]);
      expect(answer.citations.length).toBeGreaterThan(0);
      expect(answer.answerText.length).toBe(ANSWER_TEXT_FLOOR);
    }
  });
});

describe('engine_ask — network', () => {
  it('uses ctx.scopedFetch, never globalThis.fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const rec = makeRecordingFetch(answerBody('A'));
    const result = await engineAskTool.execute({ query: 'q' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    expect(rec.calls).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('forwards the arguments into the request body', async () => {
    const rec = makeRecordingFetch(answerBody('A'));
    await engineAskTool.execute(
      { query: 'cards?', country: 'IN', search_context_size: 'low', require_search: true },
      ctxWith(rec.scopedFetch),
    );
    const body = JSON.parse(String(rec.calls[0]?.init?.body));
    expect(body.input).toBe('cards?');
    expect(body.tool_choice).toBe('required');
    expect(body.tools[0]).toEqual({
      type: 'web_search',
      search_context_size: 'low',
      user_location: { type: 'approximate', country: 'IN' },
    });
  });

  it('429 and 500 are execution_failed with the status in the message', async () => {
    for (const status of [429, 500]) {
      const rec = makeRecordingFetch({ error: { message: `status ${status}` } }, status);
      const result = await engineAskTool.execute({ query: 'q' }, ctxWith(rec.scopedFetch));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('execution_failed');
        expect(result.error).toContain(String(status));
        expect(result.error).toContain(`status ${status}`);
      }
    }
  });

  it('cuts the error body to 500 characters', async () => {
    const rec = makeRecordingFetch('z'.repeat(2000), 500);
    const result = await engineAskTool.execute({ query: 'q' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.match(/z+/)?.[0]).toHaveLength(500);
  });

  it('a transport throw is execution_failed with its message', async () => {
    const throwing: ScopedFetchLike = {
      fetch: async () => {
        throw new Error('host api.openai.com not in allowedHosts');
      },
    };
    const result = await engineAskTool.execute({ query: 'q' }, ctxWith(throwing));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('allowedHosts');
    }
  });

  it('engine: "perplexity" reaches the Perplexity adapter; omitting engine still goes to OpenAI', async () => {
    const recPx = makeRecordingFetch(perplexityBody('Axis Atlas leads[web:1].'));
    const px = await engineAskTool.execute(
      { query: 'q', engine: 'perplexity' },
      ctxWith(recPx.scopedFetch),
    );
    expect(px.ok).toBe(true);
    expect(recPx.calls).toHaveLength(1);
    expect(recPx.calls[0]?.url).toBe('https://api.perplexity.ai/v1/agent');

    const recCg = makeRecordingFetch(answerBody('A'));
    const cg = await engineAskTool.execute({ query: 'q' }, ctxWith(recCg.scopedFetch));
    expect(cg.ok).toBe(true);
    expect(recCg.calls[0]?.url).toBe('https://api.openai.com/v1/responses');
  });
});

describe('engine_ask — model override', () => {
  it('the default model is gpt-5.5', async () => {
    const saved = process.env.OPENAI_ANSWER_ENGINE_MODEL;
    delete process.env.OPENAI_ANSWER_ENGINE_MODEL;
    try {
      const rec = makeRecordingFetch(answerBody('A'));
      await createEngineAskTool().execute({ query: 'q' }, ctxWith(rec.scopedFetch));
      expect(JSON.parse(String(rec.calls[0]?.init?.body)).model).toBe('gpt-5.5');
    } finally {
      if (saved !== undefined) process.env.OPENAI_ANSWER_ENGINE_MODEL = saved;
    }
  });

  it('createEngineAskTool({ models }) overrides the default model in the request body', async () => {
    const rec = makeRecordingFetch(answerBody('A'));
    const tool = createEngineAskTool({ models: { chatgpt: 'gpt-custom' } });
    await tool.execute({ query: 'q' }, ctxWith(rec.scopedFetch));
    expect(JSON.parse(String(rec.calls[0]?.init?.body)).model).toBe('gpt-custom');
  });

  it('OPENAI_ANSWER_ENGINE_MODEL overrides the default when no opts.model is given', async () => {
    const saved = process.env.OPENAI_ANSWER_ENGINE_MODEL;
    process.env.OPENAI_ANSWER_ENGINE_MODEL = 'gpt-env-override';
    try {
      const rec = makeRecordingFetch(answerBody('A'));
      await createEngineAskTool().execute({ query: 'q' }, ctxWith(rec.scopedFetch));
      expect(JSON.parse(String(rec.calls[0]?.init?.body)).model).toBe('gpt-env-override');
    } finally {
      if (saved === undefined) delete process.env.OPENAI_ANSWER_ENGINE_MODEL;
      else process.env.OPENAI_ANSWER_ENGINE_MODEL = saved;
    }
  });
});

describe('engine_ask — tool contract', () => {
  it('declares name, toolset "web", maxResultChars 30_000 and untrusted output', () => {
    expect(engineAskTool.name).toBe('engine_ask');
    expect(engineAskTool.toolset).toBe('web');
    expect(engineAskTool.maxResultChars).toBe(30_000);
    expect(engineAskTool.outputIsUntrusted).toBe(true);
  });

  it('declares capabilities.network.allowedHosts = [api.openai.com, api.perplexity.ai]', () => {
    expect(engineAskTool.capabilities.network?.allowedHosts).toEqual([
      'api.openai.com',
      'api.perplexity.ai',
    ]);
  });

  it('declares a prefix grant for OpenAI and an EXACT ref for Perplexity', () => {
    // Exact equality on purpose: this is the guard that stops a "tidy-up" turning the Perplexity exact ref back into a providers/perplexity/* prefix.
    expect(engineAskTool.capabilities.secrets).toEqual([
      'providers/openai/*',
      'providers/perplexity/apiKey',
    ]);
  });

  it('schema: query required, engine enum from the roster, format and context-size enums', () => {
    const props = engineAskTool.schema.properties as Record<string, { enum?: string[] }>;
    expect(engineAskTool.schema.required).toEqual(['query']);
    expect(props.engine?.enum).toEqual(['chatgpt', 'perplexity']);
    expect(props.search_context_size?.enum).toEqual(['low', 'medium', 'high']);
    expect(props.format?.enum).toEqual(['text', 'json']);
  });

  it('declares exactly one secret-binding field with secretKind "answer-engine"', () => {
    const schema = engineAskTool.settingsSchema;
    if (!schema) throw new Error('expected engine_ask to declare a settingsSchema');
    expect(schema.fields).toHaveLength(1);
    const field = schema.fields[0];
    if (field?.kind !== 'secret-binding') throw new Error('expected a secret-binding field');
    // Keyed `secret` like x_search's binding — the tool-settings wire shape
    // (`values.engine_ask.secret`) and tools.yaml both read that key.
    expect(field.key).toBe('secret');
    expect(field.label).toBe('OpenAI API key (answer engine)');
    expect(field.secretKind).toBe('answer-engine');
  });
});
