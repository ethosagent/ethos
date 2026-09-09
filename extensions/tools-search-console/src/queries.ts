import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';
import { getAccessToken, readServiceAccount } from './auth';
import {
  API_BASE,
  type CreateSearchConsoleToolOptions,
  GSC_CAPABILITIES,
  GSC_SETTINGS_SCHEMA,
  MAX_RESULT_CHARS,
  NO_KEY_MESSAGE,
  SETTINGS_KEY,
  selectGscSecretRef,
} from './constants';
import { describeGscApiError, describeThrownGscError } from './errors';

// ---------------------------------------------------------------------------
// gsc_queries — `searchanalytics.query` over one property (§7.2).
//
// Every argument refusal happens BEFORE any network call, and the renderer is
// budget-aware: it fits rows to `maxResultChars` itself and says how many it
// dropped, because the registry's post-trim is silent as far as the tool is
// concerned and a model reads a truncated table as a complete one (D29).
// ---------------------------------------------------------------------------

export const DIMENSIONS = [
  'query',
  'page',
  'country',
  'device',
  'date',
  'searchAppearance',
] as const;
export type GscDimension = (typeof DIMENSIONS)[number];

const FORMATS = ['text', 'json'] as const;

const DEFAULT_ROW_LIMIT = 100;
const MAX_ROW_LIMIT = 1000;

/** Search Console data lags real time by ~2-3 days; defaulting `end_date` to
 *  today returns a misleadingly empty tail (D15). */
const DATA_LAG_DAYS = 3;
const DEFAULT_WINDOW_DAYS = 27;

/** The API's retention window. Beyond it Google clips to the window's start
 *  with no indication the range was changed, which reads as real data (D15).
 *  (Asserted in the plan, not verified against the live API — see §18.) */
const RETENTION_MONTHS = 16;

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface GscQueriesArgs {
  site_url: string;
  start_date?: string;
  end_date?: string;
  dimensions?: string[];
  row_limit?: number;
  format?: (typeof FORMATS)[number];
}

interface AnalyticsRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

/** `searchAnalytics.query` OMITS `rows` entirely when there are no results — it
 *  does not return `rows: []` (D28). Optional here so nothing indexes into it. */
interface AnalyticsResponse {
  rows?: AnalyticsRow[];
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Strict ISO `YYYY-MM-DD`, rejecting shapes `Date.parse` would accept and
 *  calendar-impossible days (`2026-02-31`) that it silently rolls over. */
function parseIsoDate(value: string): Date | null {
  if (!DATE_RE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  return toIso(d) === value ? d : null;
}

function clampRowLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_ROW_LIMIT;
  return Math.min(Math.max(Math.floor(value), 1), MAX_ROW_LIMIT);
}

interface ResolvedRange {
  startDate: string;
  endDate: string;
}

type RangeResult = { ok: true; range: ResolvedRange } | { ok: false; error: string };

/** Resolve and validate the date window against a caller-supplied clock. */
export function resolveRange(
  args: Pick<GscQueriesArgs, 'start_date' | 'end_date'>,
  nowMs: number,
): RangeResult {
  const now = new Date(nowMs);
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  let end: Date;
  if (args.end_date) {
    const parsed = parseIsoDate(args.end_date);
    if (!parsed)
      return { ok: false, error: `end_date must be ISO YYYY-MM-DD (got "${args.end_date}")` };
    end = parsed;
  } else {
    end = new Date(todayUtc - DATA_LAG_DAYS * DAY_MS);
  }

  let start: Date;
  if (args.start_date) {
    const parsed = parseIsoDate(args.start_date);
    if (!parsed) {
      return { ok: false, error: `start_date must be ISO YYYY-MM-DD (got "${args.start_date}")` };
    }
    start = parsed;
  } else {
    start = new Date(end.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  }

  if (end.getTime() < start.getTime()) {
    return {
      ok: false,
      error: `end_date (${toIso(end)}) is before start_date (${toIso(start)}).`,
    };
  }

  const cutoff = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() - RETENTION_MONTHS,
    now.getUTCDate(),
  );
  if (start.getTime() < cutoff) {
    return {
      ok: false,
      error:
        `start_date ${toIso(start)} is outside Search Console's ${RETENTION_MONTHS}-month retention window (earliest ${toIso(new Date(cutoff))}). ` +
        'The API clips such a range to the window start without saying so, which reads as real data — pick a later start_date.',
    };
  }

  return { ok: true, range: { startDate: toIso(start), endDate: toIso(end) } };
}

function formatPercent(ctr: number | undefined): string {
  return typeof ctr === 'number' ? `${(ctr * 100).toFixed(1)}%` : '—';
}

function formatNumber(value: number | undefined, digits = 0): string {
  return typeof value === 'number' ? value.toFixed(digits) : '—';
}

function rowCells(row: AnalyticsRow, dimensions: GscDimension[]): string[] {
  const keys = row.keys ?? [];
  return [
    ...dimensions.map((_, i) => keys[i] ?? '—'),
    formatNumber(row.clicks),
    formatNumber(row.impressions),
    formatPercent(row.ctr),
    formatNumber(row.position, 1),
  ];
}

/**
 * Fixed-width table, budget-aware (D29): rows are added while the whole result
 * still fits `MAX_RESULT_CHARS`, and the header says "showing X of Y" so the
 * model never reads a partial table as a complete one.
 */
export function renderQueriesText(
  rows: AnalyticsRow[],
  opts: { siteUrl: string; range: ResolvedRange; dimensions: GscDimension[] },
): string {
  const headerCells = [...opts.dimensions, 'clicks', 'impressions', 'ctr', 'position'];
  const bodyCells = rows.map((r) => rowCells(r, opts.dimensions));
  const widths = headerCells.map((h, i) =>
    Math.max(h.length, ...bodyCells.map((cells) => (cells[i] ?? '').length), 0),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? c.length))
      .join('  ')
      .trimEnd();

  const columnHeader = line(headerCells);
  const separator = widths.map((w) => '-'.repeat(w)).join('  ');
  const bodyLines = bodyCells.map(line);

  const notes: string[] = [];
  if (opts.dimensions.includes('query')) {
    // Google withholds rare queries from the `query` dimension for privacy, so
    // the rows are a partial denominator — and the withheld tail is the long,
    // sentence-shaped one (§18). Say so rather than implying a complete picture.
    notes.push(
      '(Google withholds rare queries for privacy, so these rows do not sum to the property totals.)',
    );
  }

  const build = (shown: number, omitted: number): string => {
    const head =
      `Search Console — ${opts.siteUrl}\n` +
      `${opts.range.startDate} to ${opts.range.endDate} · dimensions: ${opts.dimensions.join(', ')} · showing ${shown} of ${rows.length} rows\n\n` +
      `${columnHeader}\n${separator}\n`;
    const body = bodyLines.slice(0, shown).join('\n');
    const tail = [
      ...(omitted > 0
        ? [
            `(${omitted} further rows omitted to fit this tool's ${MAX_RESULT_CHARS.toLocaleString()}-character result budget — lower row_limit or narrow the range.)`,
          ]
        : []),
      ...notes,
    ];
    return `${head}${body}${tail.length > 0 ? `\n\n${tail.join('\n')}` : ''}\n`;
  };

  let shown = rows.length;
  while (shown > 0 && build(shown, rows.length - shown).length > MAX_RESULT_CHARS) shown--;
  return build(shown, rows.length - shown);
}

/** Same range metadata as the text header, plus the row array (D17). Budget-fit
 *  the same way, so a script consumer never parses a registry-truncated
 *  document. */
export function renderQueriesJson(
  rows: AnalyticsRow[],
  opts: { siteUrl: string; range: ResolvedRange; dimensions: GscDimension[] },
): string {
  const build = (shown: number) =>
    JSON.stringify(
      {
        siteUrl: opts.siteUrl,
        startDate: opts.range.startDate,
        endDate: opts.range.endDate,
        dimensions: opts.dimensions,
        rowsReturned: rows.length,
        rowsShown: shown,
        rows: rows.slice(0, shown),
      },
      null,
      2,
    );

  let shown = rows.length;
  while (shown > 0 && build(shown).length > MAX_RESULT_CHARS) shown--;
  return build(shown);
}

function renderNoData(
  opts: {
    siteUrl: string;
    range: ResolvedRange;
    dimensions: GscDimension[];
  },
  format: (typeof FORMATS)[number],
): string {
  const note =
    `No data for ${opts.range.startDate} to ${opts.range.endDate}. Search Console lags 2-3 days behind real time, ` +
    'and a freshly granted or low-traffic property often has no rows in a recent window — try a wider range.';
  if (format === 'json') {
    return JSON.stringify(
      {
        siteUrl: opts.siteUrl,
        startDate: opts.range.startDate,
        endDate: opts.range.endDate,
        dimensions: opts.dimensions,
        rowsReturned: 0,
        rowsShown: 0,
        rows: [],
        note,
      },
      null,
      2,
    );
  }
  return `Search Console — ${opts.siteUrl}\n${opts.range.startDate} to ${opts.range.endDate} · dimensions: ${opts.dimensions.join(', ')}\n\n${note}\n`;
}

export function createGscQueriesTool(opts: CreateSearchConsoleToolOptions = {}): Tool {
  return {
    name: 'gsc_queries',
    description:
      'Search Console Search Analytics for one property: the queries people typed, the pages they landed on, and clicks / impressions / CTR / average position for each. Defaults to the last 28 days ending 3 days ago (the API lags 2-3 days). Pass a siteUrl exactly as gsc_sites printed it.',
    toolset: 'web',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: GSC_CAPABILITIES,
    outputIsUntrusted: true,
    settingsKey: SETTINGS_KEY,
    settingsSchema: GSC_SETTINGS_SCHEMA,
    isAvailable() {
      return true;
    },
    schema: {
      type: 'object',
      properties: {
        site_url: {
          type: 'string',
          description:
            'The property, exactly as gsc_sites printed it — "sc-domain:example.com" or "https://www.example.com/" with the trailing slash',
        },
        start_date: {
          type: 'string',
          description: `ISO YYYY-MM-DD. Default: end_date minus ${DEFAULT_WINDOW_DAYS} days. Must be within ${RETENTION_MONTHS} months of today.`,
        },
        end_date: {
          type: 'string',
          description: `ISO YYYY-MM-DD. Default: today minus ${DATA_LAG_DAYS} days (the API's data lag).`,
        },
        dimensions: {
          type: 'array',
          items: { type: 'string', enum: [...DIMENSIONS] },
          description: "Rows are grouped by these. Default ['query'].",
        },
        row_limit: {
          type: 'number',
          description: `Rows to request (default ${DEFAULT_ROW_LIMIT}, max ${MAX_ROW_LIMIT}). One page only — there is no pagination.`,
        },
        format: {
          type: 'string',
          enum: [...FORMATS],
          description: "'text' (default) for a table, 'json' for the row array",
        },
      },
      required: ['site_url'],
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const {
        site_url,
        start_date,
        end_date,
        dimensions: rawDimensions,
        row_limit,
        format: rawFormat,
      } = args as GscQueriesArgs;

      // --- Argument refusals, all before any network call (§7.2) -------------
      const siteUrl = typeof site_url === 'string' ? site_url.trim() : '';
      if (!siteUrl) {
        return {
          ok: false,
          error: 'site_url is required — run gsc_sites and copy the property string exactly.',
          code: 'input_invalid',
        };
      }

      const dimensions: GscDimension[] = [];
      for (const d of rawDimensions ?? ['query']) {
        if (!(DIMENSIONS as readonly string[]).includes(d)) {
          return {
            ok: false,
            error: `Unknown dimension "${d}" — Search Console accepts only: ${DIMENSIONS.join(', ')}.`,
            code: 'input_invalid',
          };
        }
        dimensions.push(d as GscDimension);
      }
      if (dimensions.length === 0) dimensions.push('query');

      const resolved = resolveRange({ start_date, end_date }, Date.now());
      if (!resolved.ok) return { ok: false, error: resolved.error, code: 'input_invalid' };
      const range = resolved.range;

      const format = rawFormat === 'json' ? 'json' : 'text';
      const rowLimit = clampRowLimit(row_limit);

      // --- Credential + call -------------------------------------------------
      const secrets = ctx.secretsResolver;
      const net = ctx.scopedFetch;
      if (!secrets || !net) {
        return { ok: false, error: 'Capability backends not configured', code: 'not_available' };
      }

      try {
        const sa = await readServiceAccount(secrets, selectGscSecretRef(ctx, opts));
        if (!sa) return { ok: false, error: NO_KEY_MESSAGE, code: 'not_available' };

        const token = await getAccessToken(
          sa,
          (url, init) => net.fetch(url, init),
          ctx.abortSignal,
        );
        const response = await net.fetch(
          `${API_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify({
              startDate: range.startDate,
              endDate: range.endDate,
              dimensions,
              rowLimit,
            }),
            ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
          },
        );
        if (!response.ok) {
          return describeGscApiError(response, { clientEmail: sa.clientEmail, siteUrl });
        }

        const data = (await response.json()) as AnalyticsResponse;
        const rows = data.rows ?? [];
        const renderOpts = { siteUrl, range, dimensions };
        if (rows.length === 0) {
          return { ok: true, value: renderNoData(renderOpts, format) };
        }
        return {
          ok: true,
          value:
            format === 'json'
              ? renderQueriesJson(rows, renderOpts)
              : renderQueriesText(rows, renderOpts),
        };
      } catch (err) {
        return describeThrownGscError(err);
      }
    },
  };
}
