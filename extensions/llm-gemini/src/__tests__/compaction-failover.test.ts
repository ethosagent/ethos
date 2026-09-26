// openclaw-9.5-adoption item 7 (D33) — a session that compacted server-side on
// Anthropic and then fails over to Gemini: the persisted compaction block
// reaches `generateContent` as the readable summary in a plain `model` turn.
// The Anthropic-only encrypted half is dropped, and a failed (null-content)
// block sends nothing. Mirrors
// extensions/llm-openai-compat/src/__tests__/compaction-failover.test.ts.

import { encodeCompactionEnvelope, type Message } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamGeminiGenerate } from '../transport';

const envelope = (content: string | null): Message => ({
  role: 'assistant',
  content: encodeCompactionEnvelope({ content, encryptedContent: 'opaque-anthropic-state' }),
});

/** The request body `streamGeminiGenerate` sends for `messages`. */
async function geminiBody(messages: Message[]): Promise<{ contents: unknown[] }> {
  let captured: { contents: unknown[] } = { contents: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body));
      return new Response('data: {"candidates":[{"finishReason":"STOP"}]}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }),
  );
  for await (const _ of streamGeminiGenerate(
    { apiKey: 'k', model: 'gemini-2.5-flash' },
    messages,
    [],
    {},
  )) {
    // consume
  }
  return captured;
}

describe('Gemini — compaction envelope failover', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the summary as model text, without the encrypted content', async () => {
    const body = await geminiBody([
      { role: 'user', content: 'hello' },
      envelope('the summary'),
      { role: 'assistant', content: 'earlier reply' },
      { role: 'user', content: 'next' },
    ]);
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'the summary\n\nearlier reply' }] },
      { role: 'user', parts: [{ text: 'next' }] },
    ]);
    expect(JSON.stringify(body)).not.toContain('opaque-anthropic-state');
    expect(JSON.stringify(body)).not.toContain('ethos:compaction');
  });

  it('sends nothing for a null-content block', async () => {
    const body = await geminiBody([
      { role: 'user', content: 'hello' },
      envelope(null),
      { role: 'assistant', content: 'earlier reply' },
    ]);
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'earlier reply' }] },
    ]);
  });
});
