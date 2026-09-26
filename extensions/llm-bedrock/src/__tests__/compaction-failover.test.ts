// openclaw-9.5-adoption item 7 (D33) — a session that compacted server-side on
// Anthropic and then fails over to Bedrock: the persisted compaction block
// reaches the Converse request as the readable summary in plain assistant
// text. The Anthropic-only encrypted half is dropped, and a failed
// (null-content) block sends nothing. Mirrors
// extensions/llm-openai-compat/src/__tests__/compaction-failover.test.ts.

import { encodeCompactionEnvelope, type Message } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { staticCredentials } from '../sigv4';
import { streamBedrockConverse } from '../transport';

const envelope = (content: string | null): Message => ({
  role: 'assistant',
  content: encodeCompactionEnvelope({ content, encryptedContent: 'opaque-anthropic-state' }),
});

/** The Converse body `streamBedrockConverse` sends for `messages`. */
async function converseBody(messages: Message[]): Promise<{ messages: unknown[] }> {
  let captured: { messages: unknown[] } = { messages: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body));
      // An empty event stream: the generator ends without a chunk.
      return new Response(new Uint8Array(), { status: 200 });
    }),
  );
  for await (const _ of streamBedrockConverse(
    {
      region: 'us-east-1',
      modelId: 'anthropic.claude-sonnet',
      sigv4: { region: 'us-east-1', credentials: staticCredentials('AKID', 'secret') },
    },
    messages,
    [],
    {},
  )) {
    // consume
  }
  return captured;
}

describe('Bedrock Converse — compaction envelope failover', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the summary as assistant text, without the encrypted content', async () => {
    const body = await converseBody([
      { role: 'user', content: 'hello' },
      envelope('the summary'),
      { role: 'assistant', content: 'earlier reply' },
      { role: 'user', content: 'next' },
    ]);
    expect(body.messages).toEqual([
      { role: 'user', content: [{ text: 'hello' }] },
      { role: 'assistant', content: [{ text: 'the summary\n\nearlier reply' }] },
      { role: 'user', content: [{ text: 'next' }] },
    ]);
    expect(JSON.stringify(body)).not.toContain('opaque-anthropic-state');
    expect(JSON.stringify(body)).not.toContain('ethos:compaction');
  });

  it('sends nothing for a null-content block', async () => {
    const body = await converseBody([
      { role: 'user', content: 'hello' },
      envelope(null),
      { role: 'assistant', content: 'earlier reply' },
    ]);
    expect(body.messages).toEqual([
      { role: 'user', content: [{ text: 'hello' }] },
      { role: 'assistant', content: [{ text: 'earlier reply' }] },
    ]);
  });
});
