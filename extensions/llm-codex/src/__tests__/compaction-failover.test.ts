// openclaw-9.5-adoption item 7 (D33) — a session that compacted server-side on
// Anthropic and then fails over to Codex (the Responses API): the persisted
// compaction block reaches the `input` array as the readable summary in plain
// assistant text. The Anthropic-only encrypted half is dropped, and a failed
// (null-content) block sends nothing. Mirrors
// extensions/llm-openai-compat/src/__tests__/compaction-failover.test.ts.

import { encodeCompactionEnvelope, type Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { toResponsesInput } from '../responses-adapter';

const envelope = (content: string | null): Message => ({
  role: 'assistant',
  content: encodeCompactionEnvelope({ content, encryptedContent: 'opaque-anthropic-state' }),
});

describe('toResponsesInput — compaction envelope failover', () => {
  it('sends the summary as assistant text, without the encrypted content', () => {
    const out = toResponsesInput([
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
    expect(JSON.stringify(out)).not.toContain('ethos:compaction');
  });

  it('sends nothing for a null-content block', () => {
    const out = toResponsesInput([
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
