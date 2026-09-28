// UBP-051 — the markdown→Telegram-HTML converter ran its emphasis regexes
// inside fenced blocks and inline code (`__name__` → `<i>_name</i>_`,
// `a**2 + b**2` → `a<b>2 + b</b>2`), and Telegram's HTML parser rejects tags
// nested in <pre>/<code>, so the whole chunk fell back to plain text.
// `chunkText` could also split inside a fence, leaving both halves unmatched.

import { describe, expect, it } from 'vitest';
import { markdownToTelegramHtml } from '../format';
import { chunkText } from '../index';

const CODE = '# comment\nif __name__ == "__main__":\n    x = a**2 + b**2  # [x](y)\n';

function decode(html: string): string {
  return html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

describe('markdownToTelegramHtml code protection', () => {
  it('keeps fenced code byte for byte, HTML-escaped, with no tags inside <pre>', () => {
    const out = markdownToTelegramHtml(`Here:\n\`\`\`python\n${CODE}\`\`\`\nDone **now**`);
    const match = out.match(/<pre><code class="language-python">([\s\S]*?)<\/code><\/pre>/);
    expect(match).not.toBeNull();
    const inner = match?.[1] ?? '';
    expect(inner).not.toMatch(/<[^>]+>/);
    expect(decode(inner)).toBe(CODE);
    // Prose outside the fence is still converted.
    expect(out).toContain('<b>now</b>');
  });

  it('keeps a fence without a language byte for byte', () => {
    const out = markdownToTelegramHtml(`\`\`\`\n${CODE}\`\`\``);
    expect(out).toBe(`<pre>${out.slice(5, -6)}</pre>`);
    expect(decode(out.slice(5, -6))).toBe(CODE);
    expect(out.slice(5, -6)).not.toMatch(/<[^>]+>/);
  });

  it('keeps inline code byte for byte', () => {
    for (const code of ['__init__', 'a**2 + b**2', '[x](y)', '~~no~~', '||no||', 'a<b>&c']) {
      const out = markdownToTelegramHtml(`call \`${code}\` then _go_`);
      const match = out.match(/<code>([\s\S]*?)<\/code>/);
      expect(decode(match?.[1] ?? '')).toBe(code);
      expect(match?.[1]).not.toMatch(/<[^>]+>/);
      expect(out).toContain('<i>go</i>');
    }
  });
});

describe('chunkText fence awareness', () => {
  it('closes an open fence at the chunk boundary and reopens it in the next chunk', () => {
    const body = Array.from({ length: 80 }, (_, i) => `line_${i} = a**2`).join('\n');
    const text = `Intro\n\`\`\`python\n${body}\n\`\`\`\nOutro`;
    const chunks = chunkText(text, 400);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(400);
      // Every chunk has balanced fences on its own.
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
      // And each renders its code inside <pre> with no nested tags.
      const html = markdownToTelegramHtml(chunk);
      for (const pre of html.match(/<pre>[\s\S]*?<\/pre>/g) ?? []) {
        expect(pre.replace(/^<pre>(<code[^>]*>)?|(<\/code>)?<\/pre>$/g, '')).not.toMatch(/<[^>]+>/);
      }
    }
    // Continuation chunks reopen with the original language tag.
    expect(chunks[1].startsWith('```python\n')).toBe(true);
    // No code line is lost or duplicated.
    const lines = chunks
      .join('\n')
      .split('\n')
      .filter((l) => l.startsWith('line_'));
    expect(lines).toEqual(body.split('\n'));
  });

  it('leaves unfenced text splitting unchanged', () => {
    const text = 'word '.repeat(400);
    expect(chunkText(text, 400).join('')).toBe(text);
  });
});
