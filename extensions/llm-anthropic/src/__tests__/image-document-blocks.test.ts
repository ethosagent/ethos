// P1 — verify that the Anthropic adapter maps `image` and `document` blocks
// to the SDK's `ImageBlockParam` / `DocumentBlockParam` wire shapes. These
// are the bytes vision_analyze (P2) will rely on; if the mapper drifts the
// LLM never sees the file.

import type Anthropic from '@anthropic-ai/sdk';
import type { Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { toAnthropicMessages } from '../index';

describe('toAnthropicMessages — image + document blocks', () => {
  it('maps an image block to Anthropic ImageBlockParam with base64 source', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', mediaType: 'image/png', data: 'AAAA' },
        ],
      },
    ];

    const out = toAnthropicMessages(messages);
    expect(out.length).toBe(1);
    const content = out[0]?.content;
    if (!Array.isArray(content)) throw new Error('expected block content');

    const [textBlock, imageBlock] = content;
    expect(textBlock).toEqual({ type: 'text', text: 'what is this?' });
    expect(imageBlock).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    } satisfies Anthropic.ImageBlockParam);
  });

  it('maps a document block to Anthropic DocumentBlockParam with base64 PDF source', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'document', mediaType: 'application/pdf', data: 'JVBERi0=' },
          { type: 'text', text: 'summarise' },
        ],
      },
    ];

    const out = toAnthropicMessages(messages);
    const content = out[0]?.content;
    if (!Array.isArray(content)) throw new Error('expected block content');

    const [docBlock] = content;
    expect(docBlock).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
    } satisfies Anthropic.DocumentBlockParam);
  });

  it('preserves each image media-type variant on the wire', () => {
    const variants: Array<'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'> = [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
    ];
    for (const mediaType of variants) {
      const out = toAnthropicMessages([
        { role: 'user', content: [{ type: 'image', mediaType, data: 'AA' }] },
      ]);
      const content = out[0]?.content;
      if (!Array.isArray(content)) throw new Error('expected block content');
      const block = content[0] as Anthropic.ImageBlockParam;
      if (block.source.type !== 'base64') throw new Error('expected base64 source');
      expect(block.source.media_type).toBe(mediaType);
    }
  });
});
