// openclaw-9.5-adoption item 7 (D31/D33) — how a `compaction` chunk lives in
// history, and what a provider that cannot take the block receives instead.

import { describe, expect, it } from 'vitest';
import {
  COMPACTION_ENVELOPE_PREFIX,
  decodeCompactionEnvelope,
  encodeCompactionEnvelope,
  flattenCompactionEnvelopes,
  type Message,
} from '../llm';

describe('compaction envelope', () => {
  it('round-trips both fields byte-exact, nulls included', () => {
    const encrypted = 'AAAA+/==\u0000é\n"q"\\';
    for (const c of [
      { content: 'summary', encryptedContent: encrypted },
      { content: null, encryptedContent: null },
    ]) {
      const text = encodeCompactionEnvelope(c);
      expect(text.startsWith(COMPACTION_ENVELOPE_PREFIX)).toBe(true);
      expect(decodeCompactionEnvelope(text)).toEqual(c);
    }
  });

  it('does not read ordinary or malformed text as an envelope', () => {
    expect(decodeCompactionEnvelope('{"content":"x","encrypted_content":null}')).toBeNull();
    expect(decodeCompactionEnvelope(`${COMPACTION_ENVELOPE_PREFIX}not json`)).toBeNull();
    expect(decodeCompactionEnvelope(`${COMPACTION_ENVELOPE_PREFIX}{"content":1}`)).toBeNull();
  });
});

describe('flattenCompactionEnvelopes (D33)', () => {
  const envelope = (content: string | null): Message => ({
    role: 'assistant',
    content: encodeCompactionEnvelope({ content, encryptedContent: 'opaque' }),
  });

  it('returns the same array when there is no envelope', () => {
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    expect(flattenCompactionEnvelopes(messages)).toBe(messages);
  });

  it('merges the summary into the following assistant message and drops the encrypted half', () => {
    const out = flattenCompactionEnvelopes([
      { role: 'user', content: 'q' },
      envelope('the summary'),
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'next' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'the summary\n\nreply' },
      { role: 'user', content: 'next' },
    ]);
    expect(JSON.stringify(out)).not.toContain('opaque');
  });

  it('prepends a text block when the following assistant message is block-shaped', () => {
    const out = flattenCompactionEnvelopes([
      envelope('s'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
    ]);
    expect(out).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 's' },
          { type: 'tool_use', id: 't', name: 'x', input: {} },
        ],
      },
    ]);
  });

  it('sends nothing for a null-content (failed) block', () => {
    const out = flattenCompactionEnvelopes([
      { role: 'user', content: 'q' },
      envelope(null),
      { role: 'assistant', content: 'reply' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'reply' },
    ]);
  });

  it('keeps a trailing summary as its own assistant message', () => {
    expect(flattenCompactionEnvelopes([{ role: 'user', content: 'q' }, envelope('s')])).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 's' },
    ]);
  });
});
