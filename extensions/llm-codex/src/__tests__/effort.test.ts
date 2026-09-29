import type { CompletionChunk, CompletionOptions } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexProvider } from '../index';
import { CODEX_MODELS_URL, resetModelDiscoveryCache } from '../models';

// Presence §4 — `CompletionOptions.effort` reaches the Responses body as
// `reasoning.effort`; absent, the body is exactly what it was before effort
// existed (`medium`).

function completedStream() {
  const text = [
    ['response.output_text.delta', { delta: 'hi' }],
    ['response.completed', { response: { usage: { input_tokens: 1, output_tokens: 1 } } }],
  ]
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`)
    .join('\n');
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    text: async () => '',
  };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetModelDiscoveryCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function requestBody(options: Partial<CompletionOptions>): Promise<Record<string, unknown>> {
  const bodies: string[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith(CODEX_MODELS_URL)) {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    bodies.push(String(init?.body));
    return completedStream();
  }) as unknown as typeof fetch;
  const provider = new CodexProvider({ model: 'gpt-5.6-terra', getAccessToken: async () => 'tok' });
  const chunks: CompletionChunk[] = [];
  for await (const c of provider.complete([{ role: 'user', content: 'ping' }], [], options)) {
    chunks.push(c);
  }
  const body = bodies[0];
  if (body === undefined) throw new Error('no Responses request was sent');
  return JSON.parse(body) as Record<string, unknown>;
}

describe('codex reasoning effort', () => {
  it('sends the requested effort', async () => {
    expect((await requestBody({ effort: 'low' })).reasoning).toEqual({
      effort: 'low',
      summary: 'auto',
    });
    expect((await requestBody({ effort: 'high' })).reasoning).toEqual({
      effort: 'high',
      summary: 'auto',
    });
  });

  it("maps 'off' to 'low', the lowest effort every Codex model accepts", async () => {
    expect((await requestBody({ effort: 'off' })).reasoning).toEqual({
      effort: 'low',
      summary: 'auto',
    });
  });

  it('with no effort the body is byte-identical to the effort-less request (medium)', async () => {
    const without = await requestBody({});
    expect(without.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
    expect(JSON.stringify(await requestBody({ effort: 'medium' }))).toBe(JSON.stringify(without));
  });
});
