// UBP-013 — the outbound formatter used to run `/<[^>]+>/g` over every reply,
// deleting generics in code and anything between a `<` and a `>` in prose.
// Only real HTML tags outside code are stripped now; code is never touched.

import { describe, expect, it } from 'vitest';
import { toNativeMarkdown } from '../format';

describe('Discord toNativeMarkdown', () => {
  it('keeps generics inside a fenced block byte for byte', () => {
    const fence = '```ts\nconst m: Map<string, number[]> = new Map();\n```';
    expect(toNativeMarkdown(fence)).toBe(fence);
  });

  it('keeps generics in prose and in inline code', () => {
    expect(toNativeMarkdown('use a Map<string, number> here')).toBe(
      'use a Map<string, number> here',
    );
    expect(toNativeMarkdown('use `Array<string>` here')).toBe('use `Array<string>` here');
  });

  it('keeps comparison prose', () => {
    expect(toNativeMarkdown('if x < 5 and y > 3')).toBe('if x < 5 and y > 3');
  });

  it('keeps Discord angle-bracket syntax (mentions, channels, timestamps, embed-suppressed links)', () => {
    const text = '<@123> in <#456> at <t:1700000000:R> see <https://example.com>';
    expect(toNativeMarkdown(text)).toBe(text);
  });

  it('still strips real HTML tags outside code', () => {
    expect(toNativeMarkdown('<b>bold</b> and <br/> <span class="x">y</span>')).toBe('bold and  y');
  });

  it('leaves HTML-looking text inside code alone', () => {
    const text = '```html\n<div>hi</div>\n```\nand `<b>x</b>`';
    expect(toNativeMarkdown(text)).toBe(text);
  });

  it('rewrites markdown links outside code only', () => {
    expect(toNativeMarkdown('[docs](https://x.dev) and `[a](b)`')).toBe(
      'docs (https://x.dev) and `[a](b)`',
    );
  });
});
