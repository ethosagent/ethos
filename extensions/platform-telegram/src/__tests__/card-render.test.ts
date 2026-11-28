import type { CardEnvelope } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { cardCallbackData, parseCardCallback } from '../cards/callback';
import { renderCardForTelegram, renderSettledChoice } from '../cards/render';

// plan telegram-live-cards L2 — the pure renderer: CardEnvelope -> Telegram HTML chunks + keyboard.
// Every model-supplied string must pass through escapeHtml; only `text` bodies are markdown.

const V = 1 as const;
const TOKEN = 'ABCDEFGHJK';

const render = (card: CardEnvelope, opts: { maxLength?: number; token?: string } = {}) =>
  renderCardForTelegram(card, { token: TOKEN, ...opts });

describe('renderCardForTelegram — one case per kind', () => {
  it('text: bold title then markdown converted to HTML', () => {
    const out = render({
      kind: 'text',
      specVersion: V,
      payload: { title: 'Summary', text: 'Use **bold** and `code`.' },
    });
    expect(out.degraded).toBe(false);
    expect(out.keyboard).toBeUndefined();
    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0]).toBe('<b>Summary</b>\n\nUse <b>bold</b> and <code>code</code>.');
  });

  it('code: <pre><code class="language-x"> with escaped source', () => {
    const out = render({
      kind: 'code',
      specVersion: V,
      payload: { title: 'a.ts', language: 'typescript', code: 'if (a < b && c) {}' },
    });
    expect(out.chunks[0]).toBe(
      '<b>a.ts</b>\n<pre><code class="language-typescript">if (a &lt; b &amp;&amp; c) {}</code></pre>',
    );
  });

  it('code: a language that is not an identifier is dropped, never injected into the attribute', () => {
    const out = render({
      kind: 'code',
      specVersion: V,
      payload: { language: 'x"><script>', code: 'y' },
    });
    expect(out.chunks[0]).toBe('<pre><code>y</code></pre>');
  });

  it('alert: severity glyph + bold title + message', () => {
    const glyphs = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌' } as const;
    for (const [severity, glyph] of Object.entries(glyphs)) {
      const out = render({
        kind: 'alert',
        specVersion: V,
        payload: {
          severity: severity as keyof typeof glyphs,
          title: 'Heads up',
          message: 'Disk is 91% full.',
        },
      });
      expect(out.chunks[0]).toBe(`${glyph} <b>Heads up</b>\nDisk is 91% full.`);
    }
  });

  it('detail: title, status, one label: value line per field', () => {
    const out = render({
      kind: 'detail',
      specVersion: V,
      payload: {
        title: 'Invoice 42',
        status: 'open',
        fields: [
          { label: 'Customer', value: 'Acme' },
          { label: 'Total', value: '$1,200' },
        ],
      },
    });
    expect(out.chunks[0]).toBe(
      '<b>Invoice 42</b> <i>open</i>\n<b>Customer</b>: Acme\n<b>Total</b>: $1,200',
    );
  });

  it('item_list: status glyph, name, meta, id as plain text; degraded (no link)', () => {
    const out = render({
      kind: 'item_list',
      specVersion: V,
      payload: {
        title: 'Services',
        items: [
          { id: 'svc-1', name: 'api', status: 'ok', meta: '3 pods' },
          { id: 'svc-2', name: 'db', status: 'warn' },
          { id: 'svc-3', name: 'cache', status: 'error' },
          { id: 'svc-4', name: 'queue' },
        ],
      },
    });
    expect(out.degraded).toBe(true);
    expect(out.chunks[0]).toBe(
      [
        '<b>Services</b>',
        '🟢 <b>api</b> — <i>3 pods</i> (svc-1)',
        '🟡 <b>db</b> (svc-2)',
        '🔴 <b>cache</b> (svc-3)',
        '⚪ <b>queue</b> (svc-4)',
      ].join('\n'),
    );
  });

  it('data_table: <pre> grid, numeric columns right-aligned, totals row', () => {
    const out = render({
      kind: 'data_table',
      specVersion: V,
      payload: {
        title: 'Sectors',
        caption: 'Source: test',
        columns: [
          { key: 'name', label: 'Sector' },
          { key: 'pe', label: 'P/E', numeric: true },
        ],
        rows: [
          { name: 'Tech', pe: 31.5 },
          { name: 'Energy', pe: 9 },
        ],
        totals: { name: 'Avg', pe: 20.25 },
      },
    });
    expect(out.degraded).toBe(false);
    const html = out.chunks[0] ?? '';
    expect(html.startsWith('<b>Sectors</b>\n<pre>')).toBe(true);
    expect(html).toContain('Sector |   P/E');
    expect(html).toContain('Tech   |  31.5');
    expect(html).toContain('Energy |     9');
    expect(html).toContain('Avg    | 20.25');
    expect(html).toContain('</pre>\n<i>Source: test</i>');
  });

  it('data_table: wider than 48 columns falls back to per-row label: value blocks', () => {
    const out = render({
      kind: 'data_table',
      specVersion: V,
      payload: {
        columns: [
          { key: 'a', label: 'Alpha' },
          { key: 'b', label: 'Bravo' },
          { key: 'c', label: 'Charlie' },
        ],
        rows: [{ a: 'x'.repeat(20), b: 'y'.repeat(20), c: 'z'.repeat(20) }],
      },
    });
    expect(out.degraded).toBe(true);
    const html = out.chunks[0] ?? '';
    expect(html).not.toContain('<pre>');
    expect(html).toContain(`<b>${'x'.repeat(20)}</b>`);
    expect(html).toContain(`Bravo: ${'y'.repeat(20)}`);
    expect(html).toContain(`Charlie: ${'z'.repeat(20)}`);
  });

  it('metric_chart: per-series sparkline, first -> last, min/max, yLabel; degraded to text', () => {
    const out = render({
      kind: 'metric_chart',
      specVersion: V,
      payload: {
        title: 'Latency',
        yLabel: 'ms',
        series: [
          {
            name: 'p50',
            points: [
              { x: 'a', y: 1 },
              { x: 'b', y: 3 },
              { x: 'c', y: 5 },
              { x: 'd', y: 7 },
            ],
          },
        ],
      },
    });
    expect(out.degraded).toBe(true);
    expect(out.chunks[0]).toBe(
      '<b>Latency</b> <i>(ms)</i>\n<b>p50</b> ▁▃▆█\n1 → 7 · min 1 · max 7',
    );
  });

  it('metric_chart: a series longer than 40 points is sampled to at most 40 glyphs, keeping the last', () => {
    const points = Array.from({ length: 200 }, (_v, i) => ({ x: i, y: i }));
    const out = render({
      kind: 'metric_chart',
      specVersion: V,
      payload: { series: [{ name: 's', points }] },
    });
    const line = (out.chunks[0] ?? '').split('\n')[0] ?? '';
    const glyphs = [...line.replace('<b>s</b> ', '')];
    expect(glyphs.length).toBeLessThanOrEqual(40);
    expect(glyphs.at(-1)).toBe('█');
    expect(out.chunks[0]).toContain('0 → 199');
  });

  it('metric_chart: a flat series renders without dividing by zero', () => {
    const out = render({
      kind: 'metric_chart',
      specVersion: V,
      payload: {
        series: [
          {
            name: 'flat',
            points: [
              { x: 1, y: 4 },
              { x: 2, y: 4 },
            ],
          },
        ],
      },
    });
    expect(out.chunks[0]).toContain('▁▁');
    expect(out.chunks[0]).toContain('4 → 4');
  });

  it('recommend_actions: question + one button per row, label as button text', () => {
    const out = render({
      kind: 'recommend_actions',
      specVersion: V,
      payload: {
        question: 'Next?',
        actions: [
          { label: 'Drill into tech', prompt: 'Break down the tech sector' },
          { label: 'Compare', prompt: 'Compare to last year' },
        ],
      },
    });
    expect(out.degraded).toBe(false);
    expect(out.chunks).toEqual(['Next?']);
    expect(out.keyboard).toEqual([
      [{ label: 'Drill into tech', data: `rca:${TOKEN}:0` }],
      [{ label: 'Compare', data: `rca:${TOKEN}:1` }],
    ]);
  });

  it('recommend_actions: no question reads "Next?"', () => {
    const out = render({
      kind: 'recommend_actions',
      specVersion: V,
      payload: { actions: [{ label: 'Go', prompt: 'go' }] },
    });
    expect(out.chunks).toEqual(['Next?']);
  });

  it('recommend_actions without a token has no keyboard rather than dead buttons', () => {
    const out = renderCardForTelegram({
      kind: 'recommend_actions',
      specVersion: V,
      payload: { actions: [{ label: 'Go', prompt: 'go' }] },
    });
    expect(out.keyboard).toBeUndefined();
  });

  it('canvas: title + pointer to the web, degraded', () => {
    const out = render({
      kind: 'canvas',
      specVersion: V,
      payload: { title: 'Heatmap', html: '<div>x</div>' },
    });
    expect(out.degraded).toBe(true);
    expect(out.chunks[0]).toBe('<b>Heatmap</b>\n(interactive view — open this chat on the web)');
  });
});

describe('renderCardForTelegram — escaping', () => {
  const evil = '<script>alert(1)</script> & "q"';
  const escaped = '&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;';

  it('escapes < and & in every string field of every kind', () => {
    const cards: CardEnvelope[] = [
      { kind: 'text', specVersion: V, payload: { title: evil, text: evil } },
      { kind: 'code', specVersion: V, payload: { title: evil, code: evil } },
      { kind: 'alert', specVersion: V, payload: { severity: 'info', title: evil, message: evil } },
      {
        kind: 'detail',
        specVersion: V,
        payload: { title: evil, status: evil, fields: [{ label: evil, value: evil }] },
      },
      {
        kind: 'item_list',
        specVersion: V,
        payload: { title: evil, items: [{ id: evil, name: evil, meta: evil }] },
      },
      {
        kind: 'data_table',
        specVersion: V,
        payload: {
          title: evil,
          caption: evil,
          columns: [{ key: 'k', label: evil }],
          rows: [{ k: evil }],
          totals: { k: evil },
        },
      },
      {
        kind: 'metric_chart',
        specVersion: V,
        payload: {
          title: evil,
          yLabel: evil,
          series: [{ name: evil, points: [{ x: evil, y: 1 }] }],
        },
      },
      {
        kind: 'recommend_actions',
        specVersion: V,
        payload: { question: evil, actions: [{ label: evil, prompt: evil }] },
      },
      { kind: 'canvas', specVersion: V, payload: { title: evil, html: evil } },
    ];
    for (const card of cards) {
      const out = render(card);
      const html = out.chunks.join('\n');
      expect(html, card.kind).not.toContain('<script>');
      expect(html, card.kind).toContain('&lt;script&gt;');
    }
    // The shortest-form check: a plain-text field is escaped exactly as escapeHtml does.
    expect(
      render({ kind: 'alert', specVersion: V, payload: { severity: 'info', message: evil } })
        .chunks[0],
    ).toBe(`ℹ️ ${escaped}`);
  });

  it('a button label is plain text on the keyboard, not HTML', () => {
    const out = render({
      kind: 'recommend_actions',
      specVersion: V,
      payload: { actions: [{ label: 'a & b', prompt: 'p' }] },
    });
    expect(out.keyboard?.[0]?.[0]?.label).toBe('a & b');
  });
});

describe('renderCardForTelegram — chunking', () => {
  it('splits a long text card at maxLength with every chunk within the limit', () => {
    const para = 'word '.repeat(200).trim();
    const out = render(
      { kind: 'text', specVersion: V, payload: { text: `${para}\n\n${para}\n\n${para}` } },
      { maxLength: 500 },
    );
    expect(out.chunks.length).toBeGreaterThan(1);
    for (const chunk of out.chunks) expect(chunk.length).toBeLessThanOrEqual(500);
  });

  it('splits a long code card into balanced <pre> blocks, each within the limit', () => {
    const code = Array.from({ length: 200 }, (_v, i) => `line ${i} <x> &`).join('\n');
    const out = render({ kind: 'code', specVersion: V, payload: { code } }, { maxLength: 600 });
    expect(out.chunks.length).toBeGreaterThan(1);
    for (const chunk of out.chunks) {
      expect(chunk.length).toBeLessThanOrEqual(600);
      expect(chunk.match(/<pre>/g)?.length).toBe(chunk.match(/<\/pre>/g)?.length);
    }
  });

  it('splits an item_list at line boundaries', () => {
    const items = Array.from({ length: 50 }, (_v, i) => ({
      id: `id-${i}`,
      name: `Item number ${i}`,
      meta: 'm'.repeat(100),
    }));
    const out = render(
      { kind: 'item_list', specVersion: V, payload: { items } },
      { maxLength: 800 },
    );
    expect(out.chunks.length).toBeGreaterThan(1);
    for (const chunk of out.chunks) expect(chunk.length).toBeLessThanOrEqual(800);
  });

  it('puts the keyboard on the last chunk only (one keyboard per card)', () => {
    const out = render({
      kind: 'recommend_actions',
      specVersion: V,
      payload: {
        question: 'q '.repeat(90).trim(),
        actions: [{ label: 'Go', prompt: 'go' }],
      },
    });
    expect(out.keyboard).toHaveLength(1);
    expect(out.chunks.at(-1)).toBeDefined();
  });
});

describe('callback data', () => {
  it('every callback_data is within the 64-byte Telegram limit', () => {
    const out = render({
      kind: 'recommend_actions',
      specVersion: V,
      payload: {
        actions: [
          { label: 'one', prompt: 'p'.repeat(500) },
          { label: 'two', prompt: 'p'.repeat(500) },
          { label: 'three', prompt: 'p'.repeat(500) },
        ],
      },
    });
    const all = (out.keyboard ?? []).flat();
    expect(all).toHaveLength(3);
    for (const b of all) expect(Buffer.byteLength(b.data, 'utf-8')).toBeLessThanOrEqual(64);
  });

  it('round-trips through parseCardCallback', () => {
    expect(parseCardCallback(cardCallbackData(TOKEN, 2))).toEqual({ token: TOKEN, index: 2 });
  });

  it('parseCardCallback rejects anything malformed', () => {
    for (const bad of [
      'rca',
      'rca:',
      'rca:TOK',
      'rca:TOK:x',
      'rca:TOK:-1',
      'rca:T:O:K:1',
      'obx:a:b:1',
    ]) {
      expect(parseCardCallback(bad), bad).toBeNull();
    }
  });
});

describe('renderSettledChoice', () => {
  it('shows the question and the chosen label', () => {
    expect(renderSettledChoice('Which sector?', 'Tech & more')).toBe(
      'Which sector?\n→ Tech &amp; more',
    );
  });

  it('defaults the question to "Next?"', () => {
    expect(renderSettledChoice(undefined, 'Go')).toBe('Next?\n→ Go');
  });
});
