// openclaw-9.5-adoption item 7 (D33) — a session that compacted server-side on
// Anthropic and then fails over (chain hop, `/model` switch) to an
// OpenAI-compatible provider: the persisted compaction block reaches it as the
// readable summary in plain assistant text. The Anthropic-only encrypted half
// is dropped, and a failed (null-content) block sends nothing.

import { encodeCompactionEnvelope, type Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { toOpenAIMessages } from '../index';

const envelope = (content: string | null): Message => ({
  role: 'assistant',
  content: encodeCompactionEnvelope({ content, encryptedContent: 'opaque-anthropic-state' }),
});

describe('toOpenAIMessages — compaction envelope failover', () => {
  it('sends the summary as assistant text, without the encrypted content', () => {
    const out = toOpenAIMessages([
      { role: 'user', content: 'hello' },
      envelope('the summary'),
      { role: 'assistant', content: 'earlier reply' },
      { role: 'user', content: 'next' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'the summary\n\nearlier reply' },
      { role: 'user', content: 'next' },
    ]);
    expect(JSON.stringify(out)).not.toContain('opaque-anthropic-state');
  });

  it('sends nothing for a null-content block', () => {
    const out = toOpenAIMessages([
      { role: 'user', content: 'hello' },
      envelope(null),
      { role: 'assistant', content: 'earlier reply' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'earlier reply' },
    ]);
  });
});
