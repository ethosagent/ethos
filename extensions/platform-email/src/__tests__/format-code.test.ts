// UBP-051 — the email HTML converter ran its emphasis, header, link and list
// rewrites inside code (`__name__` → `<em>_name</em>`, `a**2 + b**2` →
// `a<strong>2 + b</strong>2` inside <pre>) and left prose `<`/`>` unescaped in
// the HTML body.

import { describe, expect, it } from 'vitest';
import { toNativeMarkdown } from '../format';

const CODE = '# comment\nif __name__ == "__main__":\n\n    x = a**2 + b**2  # [x](y)\n- item\n';

function decode(html: string): string {
  return html.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

describe('email toNativeMarkdown code protection', () => {
  it('keeps a fenced block byte for byte inside <pre><code>', () => {
    const out = toNativeMarkdown(`Intro **bold**\n\n\`\`\`python\n${CODE}\`\`\`\n\nOutro`);
    const match = out.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/);
    expect(match).not.toBeNull();
    expect(match?.[1]).not.toMatch(/<[^>]+>/);
    expect(decode(match?.[1] ?? '')).toBe(CODE);
    expect(out).toContain('<strong>bold</strong>');
  });

  it('keeps inline code byte for byte', () => {
    for (const code of ['__init__', 'a**2 + b**2', '[x](y)', 'a<b>&c']) {
      const out = toNativeMarkdown(`call \`${code}\` now`);
      const match = out.match(/<code>([\s\S]*?)<\/code>/);
      expect(decode(match?.[1] ?? '')).toBe(code);
      expect(match?.[1]).not.toMatch(/<[^>]+>/);
    }
  });

  it('escapes bare < and > in prose', () => {
    expect(toNativeMarkdown('if x < 5 and y > 3 use <script>')).toBe(
      '<p>if x &lt; 5 and y &gt; 3 use &lt;script&gt;</p>',
    );
  });

  it('still renders markdown outside code', () => {
    expect(toNativeMarkdown('# Title')).toBe('<h1>Title</h1>');
    expect(toNativeMarkdown('see [docs](https://x.dev/?a=1&b=2)')).toContain(
      '<a href="https://x.dev/?a=1&amp;b=2">docs</a>',
    );
  });
});
