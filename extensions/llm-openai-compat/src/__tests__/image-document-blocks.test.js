// P1 — OpenAI-compat adapter must carry image + document MessageContent
// blocks through to the wire shape OpenAI Chat Completions documents.
//   - image  → { type: 'image_url', image_url: { url: 'data:<mt>;base64,<data>' } }
//   - document(PDF) → { type: 'file', file: { file_data: 'data:application/pdf;base64,...', filename } }
//
// Some OpenAI-compatible backends (Ollama, older Gemini) will reject the
// `file` part — the capability table in vision_analyze (P2) gates that.
import { describe, expect, it } from 'vitest';
import { toOpenAIMessages } from '../index';

describe('toOpenAIMessages — image + document blocks', () => {
  it('emits an image_url multipart for an image block', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'caption this' },
          { type: 'image', mediaType: 'image/png', data: 'AAAA' },
        ],
      },
    ];
    const out = toOpenAIMessages(messages);
    expect(out.length).toBe(1);
    const msg = out[0];
    if (msg?.role !== 'user') throw new Error('expected user message');
    expect(Array.isArray(msg.content)).toBe(true);
    if (!Array.isArray(msg.content)) throw new Error('expected array content');
    expect(msg.content).toEqual([
      { type: 'text', text: 'caption this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });
  it('emits a file multipart for a PDF document block', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'summarise' },
          { type: 'document', mediaType: 'application/pdf', data: 'JVBERi0=' },
        ],
      },
    ];
    const out = toOpenAIMessages(messages);
    const msg = out[0];
    if (msg?.role !== 'user' || !Array.isArray(msg.content)) {
      throw new Error('expected multipart user message');
    }
    expect(msg.content).toEqual([
      { type: 'text', text: 'summarise' },
      {
        type: 'file',
        file: {
          file_data: 'data:application/pdf;base64,JVBERi0=',
          filename: 'document.pdf',
        },
      },
    ]);
  });
  it('preserves all four image mediaType variants in the data: URI', () => {
    const variants = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    for (const mediaType of variants) {
      const out = toOpenAIMessages([
        { role: 'user', content: [{ type: 'image', mediaType, data: 'XX' }] },
      ]);
      const msg = out[0];
      if (msg?.role !== 'user' || !Array.isArray(msg.content)) {
        throw new Error('expected multipart');
      }
      const part = msg.content[0];
      if (part?.type !== 'image_url') throw new Error('expected image_url part');
      expect(part.image_url.url).toBe(`data:${mediaType};base64,XX`);
    }
  });
  it('still emits plain string content when no media is present (regression)', () => {
    const out = toOpenAIMessages([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      },
    ]);
    expect(out).toEqual([{ role: 'user', content: 'hello' }]);
  });
});
