import type { CardEnvelope } from '@ethosagent/web-contracts';
import { chunkText } from '../chunk';
import { escapeHtml, markdownToTelegramHtml } from '../format';
import { cardCallbackData } from './callback';

// ---------------------------------------------------------------------------
// CardEnvelope -> Telegram HTML (plan telegram-live-cards D1, L2)
//
// Pure: no I/O, no adapter state. Every model-supplied string goes through `escapeHtml`; only a
// `text` card's body goes through `markdownToTelegramHtml`. Output is split into chunks that each
// fit `maxLength` and each carry balanced tags, so a chunk never needs the plain-text fallback
// (D18) because of where it was cut. Pinned by `__tests__/card-render.test.ts`.
// ---------------------------------------------------------------------------

/** One inline-keyboard button. Same shape as `InlineButton` in `../index.ts`. */
export interface CardButton {
  label: string;
  /** `callback_data`, 1..64 bytes. */
  data: string;
}

export interface RenderedCard {
  /** Telegram HTML, one entry per message. Never empty. */
  chunks: string[];
  /** Row-major inline keyboard. It belongs on the LAST chunk. */
  keyboard?: CardButton[][];
  /** True when the kind lost fidelity in the translation (no link, text sparkline, wide table). */
  degraded: boolean;
}

export interface RenderOptions {
  /** Telegram's per-message limit. Default 4096. */
  maxLength?: number;
  /** Keys the `recommend_actions` buttons in `CardActionStore`. Absent = no keyboard. */
  token?: string;
}

const DEFAULT_MAX_LENGTH = 4096;
/** A `data_table` grid wider than this many columns of text becomes per-row blocks. */
const TABLE_MAX_WIDTH = 48;
const SPARK_GLYPHS = '▁▂▃▄▅▆▇█';
const SPARK_MAX_POINTS = 40;
const SEVERITY_GLYPH = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌' } as const;
const STATUS_GLYPH = { ok: '🟢', warn: '🟡', error: '🔴', neutral: '⚪' } as const;
const CANVAS_POINTER = '(interactive view — open this chat on the web)';
const PRE_OPEN = '<pre>';
const PRE_CLOSE = '</pre>';

// --- low-level helpers -------------------------------------------------------------------------

/** One display line: newlines and runs of whitespace collapse so a field cannot add rows. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function bold(text: string): string {
  return `<b>${escapeHtml(text)}</b>`;
}

function italic(text: string): string {
  return `<i>${escapeHtml(text)}</i>`;
}

const len = (text: string): number => [...text].length;

/**
 * Cut a single over-long HTML line into pieces of at most `max` characters. Tags are dropped from
 * such a line (a cut could unbalance them) and a cut never lands inside an `&…;` entity.
 */
function hardSplit(line: string, max: number): string[] {
  const plain = line.replace(/<[^>]*>/g, '');
  const pieces: string[] = [];
  let rest = plain;
  while (rest.length > max) {
    let cut = max;
    const amp = rest.lastIndexOf('&', cut - 1);
    if (amp !== -1 && rest.indexOf(';', amp) >= cut) cut = amp;
    if (cut <= 0) cut = max;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/** Greedy-pack `lines` into chunks of at most `max` characters, joined by newlines. */
function packLines(lines: string[], max: number): string[] {
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current) chunks.push(current);
    current = '';
  };
  for (const raw of lines) {
    const parts = raw.length > max ? hardSplit(raw, max) : [raw];
    for (const line of parts) {
      if (current === '') current = line;
      else if (current.length + 1 + line.length <= max) current += `\n${line}`;
      else {
        flush();
        current = line;
      }
    }
  }
  flush();
  return chunks;
}

/** Pack already-escaped `lines` into balanced `open…close` blocks that each fit `max`. */
function preBlocks(lines: string[], max: number, open: string, close: string): string[] {
  const budget = Math.max(1, max - open.length - close.length);
  return packLines(lines, budget).map((body) => `${open}${body}${close}`);
}

/**
 * Pack a card: `lead` lines, then a `<pre>` group, then `tail` lines. The `<pre>` group never
 * straddles a chunk boundary unbalanced — an oversize group is re-wrapped block by block.
 */
function packWithPre(
  lead: string[],
  pre: { lines: string[]; open?: string } | undefined,
  tail: string[],
  max: number,
): string[] {
  const open = pre?.open ?? PRE_OPEN;
  const close = open === PRE_OPEN ? PRE_CLOSE : '</code></pre>';
  const blocks = pre ? preBlocks(pre.lines, max, open, close) : [];
  return packLines([...lead, ...blocks, ...tail], max);
}

// --- per-kind renderers ------------------------------------------------------------------------

function fitMarkdown(markdown: string, max: number): string[] {
  let budget = max;
  for (let attempt = 0; attempt < 8; attempt++) {
    const html = chunkText(markdown, budget).map((c) => markdownToTelegramHtml(c).trimEnd());
    if (html.every((c) => c.length <= max)) return html.filter((c) => c.length > 0);
    budget = Math.floor(budget * 0.8);
  }
  // Escaping blew past every budget: degrade to escaped plain text, which `packLines` can cut.
  return packLines(escapeHtml(markdown).split('\n'), max);
}

function renderText(p: { title?: string; text: string }, max: number): RenderedCard {
  const head = p.title ? `${bold(p.title)}\n\n` : '';
  const body = fitMarkdown(p.text, Math.max(1, max - head.length));
  const chunks = body.length > 0 ? body : [''];
  chunks[0] = `${head}${chunks[0]}`.trimEnd();
  return { chunks, degraded: false };
}

function safeLanguage(language: string | undefined): string | undefined {
  return language && /^[A-Za-z0-9_+#.-]{1,32}$/.test(language) ? language : undefined;
}

function renderCode(
  p: { title?: string; language?: string; code: string },
  max: number,
): RenderedCard {
  const lang = safeLanguage(p.language);
  const open = lang ? `<pre><code class="language-${lang}">` : '<pre><code>';
  const lines = p.code.split('\n').map(escapeHtml);
  const chunks = packWithPre(p.title ? [bold(p.title)] : [], { lines, open }, [], max);
  return { chunks, degraded: false };
}

function renderAlert(
  p: { severity: keyof typeof SEVERITY_GLYPH; title?: string; message: string },
  max: number,
): RenderedCard {
  const glyph = SEVERITY_GLYPH[p.severity];
  const lines = p.title
    ? [`${glyph} ${bold(p.title)}`, ...p.message.split('\n').map(escapeHtml)]
    : [`${glyph} ${escapeHtml(p.message)}`];
  return { chunks: packLines(lines, max), degraded: false };
}

function renderDetail(
  p: { title: string; status?: string; fields: Array<{ label: string; value: string }> },
  max: number,
): RenderedCard {
  const head = p.status ? `${bold(p.title)} ${italic(p.status)}` : bold(p.title);
  const lines = [head, ...p.fields.map((f) => `${bold(f.label)}: ${escapeHtml(oneLine(f.value))}`)];
  return { chunks: packLines(lines, max), degraded: false };
}

function renderItemList(
  p: {
    title?: string;
    items: Array<{ id: string; name: string; status?: keyof typeof STATUS_GLYPH; meta?: string }>;
  },
  max: number,
): RenderedCard {
  const lines = p.items.map((item) => {
    const glyph = STATUS_GLYPH[item.status ?? 'neutral'];
    const meta = item.meta ? ` — ${italic(oneLine(item.meta))}` : '';
    return `${glyph} ${bold(oneLine(item.name))}${meta} (${escapeHtml(oneLine(item.id))})`;
  });
  const chunks = packLines(p.title ? [bold(p.title), ...lines] : lines, max);
  // No link: `id` is a stable identifier the web client turns into one; here it is plain text.
  return { chunks, degraded: true };
}

type Cell = string | number | null | undefined;

function fmtNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function cellText(cell: Cell): string {
  if (cell === null || cell === undefined) return '—';
  return typeof cell === 'number' ? fmtNumber(cell) : oneLine(cell);
}

function renderDataTable(
  p: {
    title?: string;
    caption?: string;
    columns: Array<{ key: string; label: string; numeric?: boolean }>;
    rows: Array<Record<string, Cell>>;
    totals?: Record<string, Cell>;
  },
  max: number,
): RenderedCard {
  const { columns } = p;
  const body = p.rows.map((row) => columns.map((c) => cellText(row[c.key])));
  const totals = p.totals ? columns.map((c) => cellText(p.totals?.[c.key])) : undefined;
  const widths = columns.map((c, i) =>
    Math.max(
      len(oneLine(c.label)),
      ...body.map((r) => len(r[i] ?? '')),
      totals ? len(totals[i] ?? '') : 0,
    ),
  );
  const gridWidth = widths.reduce((a, w) => a + w, 0) + 3 * (columns.length - 1);
  const lead = p.title ? [bold(p.title)] : [];
  const tail = p.caption ? [italic(oneLine(p.caption))] : [];

  if (gridWidth > TABLE_MAX_WIDTH) {
    const blocks: string[] = [];
    p.rows.forEach((_row, r) => {
      const cells = body[r] ?? [];
      const lines = [bold(cells[0] ?? '')];
      columns.slice(1).forEach((c, i) => {
        lines.push(`${escapeHtml(oneLine(c.label))}: ${escapeHtml(cells[i + 1] ?? '')}`);
      });
      blocks.push(lines.join('\n'));
    });
    if (totals) {
      const lines = [bold('Totals')];
      columns.forEach((c, i) => {
        lines.push(`${escapeHtml(oneLine(c.label))}: ${escapeHtml(totals[i] ?? '')}`);
      });
      blocks.push(lines.join('\n'));
    }
    // Blank line between records; an empty entry is a blank line to `packLines`.
    const lines = blocks.flatMap((b, i) => (i === 0 ? b.split('\n') : ['', ...b.split('\n')]));
    return { chunks: packLines([...lead, ...lines, ...tail], max), degraded: true };
  }

  const pad = (text: string, i: number): string =>
    columns[i]?.numeric ? text.padStart(widths[i] ?? 0) : text.padEnd(widths[i] ?? 0);
  const gridLine = (cells: string[]): string =>
    escapeHtml(cells.map((c, i) => pad(c, i)).join(' | ')).trimEnd();
  const rule = widths.map((w) => '─'.repeat(w)).join('─┼─');
  const lines = [
    gridLine(columns.map((c) => oneLine(c.label))),
    rule,
    ...body.map(gridLine),
    ...(totals ? [rule, gridLine(totals)] : []),
  ];
  return { chunks: packWithPre(lead, { lines }, tail, max), degraded: false };
}

function sparkline(values: number[]): string {
  const sampled =
    values.length <= SPARK_MAX_POINTS
      ? values
      : Array.from({ length: SPARK_MAX_POINTS }, (_v, i) => {
          const at = Math.round((i * (values.length - 1)) / (SPARK_MAX_POINTS - 1));
          return values[at] ?? 0;
        });
  const lo = Math.min(...sampled);
  const hi = Math.max(...sampled);
  const top = SPARK_GLYPHS.length - 1;
  return [...sampled]
    .map((v) => SPARK_GLYPHS[hi === lo ? 0 : Math.round(((v - lo) / (hi - lo)) * top)])
    .join('');
}

function renderMetricChart(
  p: {
    title?: string;
    xLabel?: string;
    yLabel?: string;
    series: Array<{ name: string; points: Array<{ x: string | number; y: number }> }>;
  },
  max: number,
): RenderedCard {
  const lines: string[] = [];
  if (p.title || p.yLabel) {
    const head = [p.title ? bold(p.title) : '', p.yLabel ? italic(`(${p.yLabel})`) : '']
      .filter(Boolean)
      .join(' ');
    lines.push(head);
  }
  if (p.xLabel) lines.push(italic(`x: ${p.xLabel}`));
  for (const s of p.series) {
    const ys = s.points.map((pt) => pt.y);
    const first = ys[0] ?? 0;
    const last = ys[ys.length - 1] ?? 0;
    lines.push(`${bold(s.name)} ${sparkline(ys)}`);
    lines.push(
      `${fmtNumber(first)} → ${fmtNumber(last)} · min ${fmtNumber(Math.min(...ys))} · max ${fmtNumber(Math.max(...ys))}`,
    );
  }
  return { chunks: packLines(lines, max), degraded: true };
}

function renderRecommendActions(
  p: { question?: string; actions: Array<{ label: string; prompt: string }> },
  max: number,
  token: string | undefined,
): RenderedCard {
  const chunks = packLines(escapeHtml(p.question ?? 'Next?').split('\n'), max);
  const keyboard: CardButton[][] | undefined = token
    ? p.actions.map((a, i) => [{ label: a.label, data: cardCallbackData(token, i) }])
    : undefined;
  return { chunks, ...(keyboard ? { keyboard } : {}), degraded: false };
}

function renderCanvas(p: { title?: string }, max: number): RenderedCard {
  const lines = [...(p.title ? [bold(p.title)] : []), CANVAS_POINTER];
  return { chunks: packLines(lines, max), degraded: true };
}

// --- public API --------------------------------------------------------------------------------

/** Render a validated card envelope as Telegram HTML chunks plus, for `recommend_actions`, a keyboard. */
export function renderCardForTelegram(card: CardEnvelope, opts: RenderOptions = {}): RenderedCard {
  const max = opts.maxLength ?? DEFAULT_MAX_LENGTH;
  switch (card.kind) {
    case 'text':
      return renderText(card.payload, max);
    case 'code':
      return renderCode(card.payload, max);
    case 'alert':
      return renderAlert(card.payload, max);
    case 'detail':
      return renderDetail(card.payload, max);
    case 'item_list':
      return renderItemList(card.payload, max);
    case 'data_table':
      return renderDataTable(card.payload, max);
    case 'metric_chart':
      return renderMetricChart(card.payload, max);
    case 'recommend_actions':
      return renderRecommendActions(card.payload, max, opts.token);
    case 'canvas':
      return renderCanvas(card.payload, max);
  }
}

/** What a `recommend_actions` card reads once a button was chosen: the question and `→ label`. */
export function renderSettledChoice(question: string | undefined, label: string): string {
  return `${escapeHtml(question ?? 'Next?')}\n→ ${escapeHtml(label)}`;
}
