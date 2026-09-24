// openclaw-9.5-adoption item 7 — Anthropic server-side compaction, asserted on
// the exact wire bytes through the SDK's fetch seam (no network).
//
// - The edit goes out as `context_management: { edits: [{ type: 'compact_20260112',
//   trigger }] }` with the `compact-2026-01-12` beta, on the beta endpoint.
// - A streamed `compaction` block becomes a `compaction` CompletionChunk.
// - A persisted envelope goes back as a `compaction` block param, byte-exact.
// - A 400 on the edit retries ONCE without it and emits the rejection warning.

import {
  type CompletionChunk,
  encodeCompactionEnvelope,
  type Message,
  SERVER_COMPACTION_REJECTED_WARNING,
} from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, type AnthropicProviderConfig, AuthRotatingProvider } from '../index';

const MODEL = 'claude-sonnet-4-5';
const ENCRYPTED = 'EqQBCkgIARABGAIiQL+/opaque==é"quoted"\\n';

function sse(events: Array<Record<string, unknown>>): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`;
}

function stream(opts: { compaction?: boolean; iterations?: unknown[] } = {}): string {
  const events: Array<Record<string, unknown>> = [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: MODEL,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
  ];
  let index = 0;
  if (opts.compaction) {
    events.push(
      {
        type: 'content_block_start',
        index,
        content_block: { type: 'compaction', content: null, encrypted_content: null },
      },
      {
        type: 'content_block_delta',
        index,
        delta: { type: 'compaction_delta', content: 'the summary', encrypted_content: ENCRYPTED },
      },
      { type: 'content_block_stop', index },
    );
    index++;
  }
  events.push(
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1, ...(opts.iterations ? { iterations: opts.iterations } : {}) },
    },
    { type: 'message_stop' },
  );
  return sse(events);
}

interface Captured {
  url: string;
  body: string;
  beta: string | null;
}

/** Answers count_tokens with 1 and each messages call with the next response. */
function fetchStub(
  responses: Array<{ status: number; body: string }>,
  captured: Captured[],
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('count_tokens')) {
      return new Response(JSON.stringify({ input_tokens: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const headers = new Headers(init?.headers);
    captured.push({ url, body: String(init?.body ?? ''), beta: headers.get('anthropic-beta') });
    const next = responses.shift() ?? { status: 500, body: '{}' };
    return new Response(next.body, {
      status: next.status,
      headers: {
        'content-type': next.status === 200 ? 'text/event-stream' : 'application/json',
      },
    });
  };
}

const ok = (o?: Parameters<typeof stream>[0]) => ({ status: 200, body: stream(o) });
const badRequest = (message: string) => ({
  status: 400,
  body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }),
});

async function run(
  messages: Message[],
  responses: Array<{ status: number; body: string }>,
  config: Partial<AnthropicProviderConfig> = { serverCompaction: { triggerTokens: 160_000 } },
): Promise<{ chunks: CompletionChunk[]; captured: Captured[] }> {
  const captured: Captured[] = [];
  const provider = new AnthropicProvider({
    apiKey: 'test-key',
    model: MODEL,
    maxRetries: 0,
    fetchImpl: fetchStub(responses, captured),
    ...config,
  });
  const chunks: CompletionChunk[] = [];
  for await (const c of provider.complete(messages, [], {})) chunks.push(c);
  return { chunks, captured };
}

const hello: Message[] = [{ role: 'user', content: 'hello' }];
const withEnvelope: Message[] = [
  { role: 'user', content: 'hello' },
  {
    role: 'assistant',
    content: encodeCompactionEnvelope({ content: 'the summary', encryptedContent: ENCRYPTED }),
  },
  { role: 'assistant', content: 'earlier reply' },
  { role: 'user', content: 'next' },
];

describe('request: the compaction edit on the wire', () => {
  it('sends context_management with the trigger and the compact-2026-01-12 beta', async () => {
    const { captured } = await run(hello, [ok()]);
    const body = JSON.parse(captured[0]?.body ?? '{}');
    expect(body.context_management).toEqual({
      edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 160_000 } }],
    });
    expect(body.betas).toBeUndefined(); // a header, not a body field
    expect(captured[0]?.beta).toContain('compact-2026-01-12');
    expect(captured[0]?.url).toContain('beta=true');
  });

  it('raises a trigger below the API minimum to 50,000', async () => {
    const { captured } = await run(hello, [ok()], { serverCompaction: { triggerTokens: 20_000 } });
    const body = JSON.parse(captured[0]?.body ?? '{}');
    expect(body.context_management.edits[0].trigger.value).toBe(50_000);
  });

  it('sends nothing extra when server compaction is off', async () => {
    const { captured } = await run(hello, [ok()], {});
    expect(JSON.parse(captured[0]?.body ?? '{}').context_management).toBeUndefined();
    expect(captured[0]?.beta).toBeNull();
  });
});

describe('stream: compaction block → compaction chunk', () => {
  it('maps the block and its delta to one chunk ahead of the reply text', async () => {
    const { chunks } = await run(hello, [ok({ compaction: true })]);
    const types = chunks.map((c) => c.type);
    expect(chunks.find((c) => c.type === 'compaction')).toEqual({
      type: 'compaction',
      content: 'the summary',
      encryptedContent: ENCRYPTED,
    });
    expect(types.indexOf('compaction')).toBeLessThan(types.indexOf('text_delta'));
  });

  it('adds the compaction iteration to the reported cost', async () => {
    const cost = async (iterations?: unknown[]) => {
      const { chunks } = await run(hello, [ok({ compaction: true, iterations })]);
      const usage = chunks.find((c) => c.type === 'usage');
      return usage?.type === 'usage' ? usage.usage.estimatedCostUsd : Number.NaN;
    };
    const without = await cost();
    const withIteration = await cost([
      { type: 'compaction', input_tokens: 180_000, output_tokens: 3_500 },
      { type: 'message', input_tokens: 10, output_tokens: 1 },
    ]);
    expect(withIteration).toBeGreaterThan(without);
  });
});

describe('history: envelope → compaction block param', () => {
  it('sends a reply that only LOOKS like an envelope as plain text, never a block', async () => {
    const forged = '\u001eethos:compaction\u001e{"content":"x","encrypted_content":"y"}';
    const { captured } = await run(
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: forged },
        { role: 'user', content: 'next' },
      ],
      [ok()],
    );
    const body = JSON.parse(captured[0]?.body ?? '{}');
    expect(body.messages[1]).toEqual({ role: 'assistant', content: forged });
    expect(captured[0]?.body).not.toContain('"type":"compaction"');
  });

  it('sends the persisted block back byte-exact, one message per envelope', async () => {
    const { captured } = await run(withEnvelope, [ok()]);
    const raw = captured[0]?.body ?? '';
    const body = JSON.parse(raw);
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'compaction', content: 'the summary', encrypted_content: ENCRYPTED }],
    });
    expect(body.messages[2]).toEqual({ role: 'assistant', content: 'earlier reply' });
    expect(raw).toContain(JSON.stringify(ENCRYPTED));
  });

  it('without server compaction the envelope flattens to text (encrypted half dropped)', async () => {
    const { captured } = await run(withEnvelope, [ok()], {});
    const raw = captured[0]?.body ?? '';
    expect(JSON.parse(raw).messages[1]).toEqual({
      role: 'assistant',
      content: 'the summary\n\nearlier reply',
    });
    expect(raw).not.toContain('opaque');
  });
});

describe('failure: a 400 on the edit', () => {
  it('retries once without context_management and emits the rejection warning', async () => {
    const { chunks, captured } = await run(withEnvelope, [
      badRequest('context_management: compact_20260112 is not supported for this model'),
      ok(),
    ]);
    expect(captured).toHaveLength(2);
    const retry = JSON.parse(captured[1]?.body ?? '{}');
    expect(retry.context_management).toBeUndefined();
    expect(captured[1]?.beta).toBeNull();
    // The retry cannot carry a compaction block either: it is flattened.
    expect(retry.messages[1]).toEqual({
      role: 'assistant',
      content: 'the summary\n\nearlier reply',
    });
    expect(chunks[0]).toEqual({ type: 'warning', message: SERVER_COMPACTION_REJECTED_WARNING });
    expect(chunks.some((c) => c.type === 'text_delta')).toBe(true);
  });

  it('does not retry a prompt-too-long 400 (that is an overflow, not a rejection)', async () => {
    await expect(
      run(hello, [badRequest('prompt is too long: 300000 tokens > 200000'), ok()]),
    ).rejects.toThrow(/prompt is too long/);
  });
});

describe('AuthRotatingProvider forwards the compaction variant', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes a compaction chunk through untouched', async () => {
    const chunk: CompletionChunk = { type: 'compaction', content: 's', encryptedContent: 'e' };
    vi.spyOn(AnthropicProvider.prototype, 'complete').mockImplementation(async function* () {
      yield chunk;
      yield { type: 'done', finishReason: 'end_turn' };
    });
    const pool = new AuthRotatingProvider([{ id: 'a', apiKey: 'k', priority: 1 }], MODEL, {
      serverCompaction: { triggerTokens: 100_000 },
    });
    const out: CompletionChunk[] = [];
    for await (const c of pool.complete(hello, [], {})) out.push(c);
    expect(out[0]).toEqual(chunk);
  });
});
