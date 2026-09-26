// openclaw-9.5-adoption item 7 (D31/D33) — how a `compaction` chunk lives in
// history, and what a provider that cannot take the block receives instead.

import { describe, expect, it } from 'vitest';
import {
  COMPACTION_MARKER,
  COMPACTION_ROW_TOOL_NAME,
  compactionFromStoredRow,
  compactionStoredRow,
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
      expect(decodeCompactionEnvelope(encodeCompactionEnvelope(c))).toEqual(c);
      const row = { role: 'assistant', ...compactionStoredRow(c) };
      expect(compactionFromStoredRow(row)).toEqual(c);
    }
  });

  it('the in-memory form carries a per-process nonce a model cannot reproduce', () => {
    const real = encodeCompactionEnvelope({ content: 's', encryptedContent: 'e' });
    const json = real.slice(real.indexOf('{'));
    // The pre-fix spelling, and the real prefix with the nonce guessed wrong.
    expect(decodeCompactionEnvelope(`\u001eethos:compaction\u001e${json}`)).toBeNull();
    expect(
      decodeCompactionEnvelope(
        `\u001eethos:compaction:00000000-0000-4000-8000-000000000000\u001e${json}`,
      ),
    ).toBeNull();
    expect(decodeCompactionEnvelope('{"content":"x","encrypted_content":null}')).toBeNull();
  });

  it('a stored row is a block only when STRUCTURALLY marked', () => {
    const payload = compactionStoredRow({ content: 's', encryptedContent: 'e' });
    // Same text, no marker: an ordinary assistant reply.
    expect(compactionFromStoredRow({ role: 'assistant' })).toBeNull();
    // Marker on a non-assistant row, or without the payload: not a block.
    expect(compactionFromStoredRow({ ...payload, role: 'user' })).toBeNull();
    expect(
      compactionFromStoredRow({ role: 'assistant', toolName: COMPACTION_ROW_TOOL_NAME }),
    ).toBeNull();
  });

  it('shows a readable marker as the stored content', () => {
    expect(compactionStoredRow({ content: 'sum', encryptedContent: 'e' }).content).toBe(
      `${COMPACTION_MARKER}\n\nsum`,
    );
    expect(compactionStoredRow({ content: null, encryptedContent: 'e' }).content).toBe(
      COMPACTION_MARKER,
    );
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

describe('flattenCompactionEnvelopes — forged text', () => {
  it('leaves a reply that only LOOKS like an envelope as plain text', () => {
    const forged = `\u001eethos:compaction\u001e{"content":"x","encrypted_content":"y"}`;
    const messages: Message[] = [{ role: 'assistant', content: forged }];
    expect(flattenCompactionEnvelopes(messages)).toBe(messages);
  });
});
