import { createHash } from 'node:crypto';
import type { ShareSnapshotWire } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { escapeHtml, NOT_FOUND_PAGE, renderSharePage } from '../render';

// plan share-links §3 Public page, D5, D6; mockup screen 2 and 2b.
const XSS = '</script><img src=x onerror=alert(1)>';
const base: ShareSnapshotWire = {
  v: 1,
  title: 'Fix <b>retry</b>',
  personalityId: 'engineer',
  createdAt: '2026-11-26T14:20:00.000Z',
  turns: [
    { role: 'user', text: `${XSS} "q" 'a' & b` },
    {
      role: 'assistant',
      text: 'line1\nline2',
      tools: [
        { name: 'read_file', isError: false },
        { name: '<w>', isError: true },
      ],
    },
  ],
};
const render = (s = base) =>
  renderSharePage(s, { nonce: 'N0nce+/=', expiresAt: '2026-12-03T14:20:00.000Z' });

describe('escapeHtml', () => {
  it('escapes & < > " \'', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('renderSharePage', () => {
  it('renders transcript text inert', () => {
    const html = render();
    expect(html).not.toContain('<img');
    expect(html).not.toContain('</script>');
    expect(html).toContain('&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&quot;q&quot; &#39;a&#39; &amp; b');
    expect(html).toContain('<title>Fix &lt;b&gt;retry&lt;/b&gt;</title>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<(a|img|link|iframe)\b/i);
  });

  it('shows tool chips with an error flag, only when present', () => {
    const html = render();
    expect(html).toContain('<span class="chip">read_file</span>');
    expect(html).toContain('<span class="chip err">&#10007; &lt;w&gt;</span>');
    const none = render({ ...base, turns: [{ role: 'assistant', text: 'x' }] });
    expect(none).not.toContain('class="chip"');
  });

  it('carries the nonce on the one style, noindex meta, footer, pre-wrap and the font stack', () => {
    const html = render();
    expect(html.match(/<style/g)).toHaveLength(1);
    expect(html).toContain('<style nonce="N0nce+/=">');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('Read-only snapshot. Redacted at creation.');
    expect(html).toContain('white-space:pre-wrap');
    expect(html).toContain("'Geist',system-ui,sans-serif");
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).not.toContain('@font-face');
    expect(html).not.toContain('url(');
    expect(html).toContain('2026-11-26 14:20 UTC');
    expect(html).toContain('2026-12-03 14:20 UTC');
  });

  it('is deterministic', () => {
    expect(render()).toBe(render());
  });
});

describe('NOT_FOUND_PAGE', () => {
  it('matches mockup 2b and has no nonce', () => {
    expect(NOT_FOUND_PAGE.html).toContain('<h1>Not found</h1>');
    expect(NOT_FOUND_PAGE.html).toContain("This link doesn't exist or has expired.");
    expect(NOT_FOUND_PAGE.html).toContain('<style>');
    expect(NOT_FOUND_PAGE.styleHash).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
  });

  it('styleHash is the sha256 of the <style> body actually served', () => {
    const body = /<style>([\s\S]*?)<\/style>/.exec(NOT_FOUND_PAGE.html)?.[1] ?? '';
    expect(body.length).toBeGreaterThan(0);
    const digest = createHash('sha256').update(body).digest('base64');
    expect(NOT_FOUND_PAGE.styleHash).toBe(`'sha256-${digest}'`);
  });
});
