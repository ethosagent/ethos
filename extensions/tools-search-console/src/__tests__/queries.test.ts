import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTokenCache } from '../auth';
import { MAX_RESULT_CHARS } from '../constants';
import { createGscQueriesTool } from '../queries';
import { makeCtx, makeRouter } from './fixtures';

const tool = createGscQueriesTool();
const SITE = 'sc-domain:example.com';

/** A fixed clock, so the default window is an assertion rather than an estimate. */
const NOW = new Date('2026-09-09T12:34:56Z');

beforeEach(() => {
  clearTokenCache();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function rows(n: number, prefix = 'query') {
  return Array.from({ length: n }, (_, i) => ({
    keys: [`${prefix} ${i}`],
    clicks: i,
    impressions: i * 10,
    ctr: 0.1234,
    position: 4.56,
  }));
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body));
}

describe('gsc_queries argument handling', () => {
  it('defaults to the last 28 days ending today-3 (D15)', async () => {
    const { scopedFetch, calls } = makeRouter(() => Response.json({ rows: rows(2) }));
    const result = await tool.execute({ site_url: SITE }, makeCtx(scopedFetch));

    expect(result.ok).toBe(true);
    const body = bodyOf(calls[1]?.init);
    // today = 2026-09-09 → end = 2026-09-06, start = end - 27 = 2026-08-10.
    expect(body.startDate).toBe('2026-08-10');
    expect(body.endDate).toBe('2026-09-06');
    expect(body.dimensions).toEqual(['query']);
    expect(body.rowLimit).toBe(100);
    if (!result.ok) return;
    expect(result.value).toContain('2026-08-10 to 2026-09-06');
  });

  it('refuses a start_date outside the 16-month window before any network call', async () => {
    const { scopedFetch, calls } = makeRouter(() => Response.json({ rows: rows(1) }));
    const result = await tool.execute(
      { site_url: SITE, start_date: '2025-04-01' },
      makeCtx(scopedFetch),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('input_invalid');
    expect(result.error).toContain('16-month retention window');
    expect(calls).toHaveLength(0);
  });

  it('refuses an absent site_url before any network call', async () => {
    const { scopedFetch, calls } = makeRouter(() => Response.json({}));
    const result = await tool.execute({ site_url: '  ' }, makeCtx(scopedFetch));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('input_invalid');
    expect(result.error).toContain('site_url is required');
    expect(calls).toHaveLength(0);
  });

  it('refuses an end_date before start_date before any network call', async () => {
    const { scopedFetch, calls } = makeRouter(() => Response.json({}));
    const result = await tool.execute(
      { site_url: SITE, start_date: '2026-08-01', end_date: '2026-07-01' },
      makeCtx(scopedFetch),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('input_invalid');
    expect(result.error).toContain('is before start_date');
    expect(calls).toHaveLength(0);
  });

  it('refuses a dimension outside the six the API accepts', async () => {
    const { scopedFetch, calls } = makeRouter(() => Response.json({}));
    const result = await tool.execute(
      { site_url: SITE, dimensions: ['query', 'browser'] },
      makeCtx(scopedFetch),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('input_invalid');
    expect(result.error).toContain('browser');
    expect(calls).toHaveLength(0);
  });

  it('clamps row_limit to 1000 and passes the requested dimensions through', async () => {
    const { scopedFetch, calls } = makeRouter(() => Response.json({ rows: rows(1) }));
    await tool.execute(
      { site_url: SITE, row_limit: 5000, dimensions: ['query', 'page'] },
      makeCtx(scopedFetch),
    );

    const body = bodyOf(calls[1]?.init);
    expect(body.rowLimit).toBe(1000);
    expect(body.dimensions).toEqual(['query', 'page']);
  });

  it('URL-encodes the property into the request path', async () => {
    const { scopedFetch, calls } = makeRouter(() => Response.json({ rows: rows(1) }));
    await tool.execute({ site_url: 'https://www.example.com/' }, makeCtx(scopedFetch));

    expect(calls[1]?.url).toBe(
      'https://searchconsole.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fwww.example.com%2F/searchAnalytics/query',
    );
  });
});

describe('gsc_queries rendering', () => {
  it('treats a response with NO rows key as ok, naming the range and the lag (D28)', async () => {
    // The API omits `rows` entirely when there are no results — it does not
    // return `rows: []`.
    const { scopedFetch } = makeRouter(() => Response.json({}));
    const result = await tool.execute({ site_url: SITE }, makeCtx(scopedFetch));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('No data for 2026-08-10 to 2026-09-06');
    expect(result.value).toContain('2-3 days');
  });

  it('renders exactly row_limit rows with an accurate showing-X-of-Y header', async () => {
    const { scopedFetch } = makeRouter(() => Response.json({ rows: rows(5) }));
    const result = await tool.execute({ site_url: SITE, row_limit: 5 }, makeCtx(scopedFetch));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('showing 5 of 5 rows');
    expect(result.value).toContain('query 4');
    expect(result.value).toContain('12.3%');
    expect(result.value).toContain('4.6');
  });

  it('fits rows to maxResultChars and says how many it dropped (D29)', async () => {
    const { scopedFetch } = makeRouter(() =>
      Response.json({ rows: rows(1000, 'a fairly long search query about something') }),
    );
    const result = await tool.execute({ site_url: SITE, row_limit: 1000 }, makeCtx(scopedFetch));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(result.value).toContain(' of 1000 rows');
    expect(result.value).not.toContain('showing 1000 of 1000 rows');
    expect(result.value).toContain('further rows omitted');
  });

  it('names the partial denominator when grouping by query', async () => {
    const { scopedFetch } = makeRouter(() => Response.json({ rows: rows(2) }));
    const result = await tool.execute({ site_url: SITE }, makeCtx(scopedFetch));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('withholds rare queries');
  });

  it("format: 'json' emits parseable JSON carrying the same range the text header names", async () => {
    const { scopedFetch } = makeRouter(() => Response.json({ rows: rows(3) }));
    const result = await tool.execute({ site_url: SITE, format: 'json' }, makeCtx(scopedFetch));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.value);
    expect(parsed.siteUrl).toBe(SITE);
    expect(parsed.startDate).toBe('2026-08-10');
    expect(parsed.endDate).toBe('2026-09-06');
    expect(parsed.dimensions).toEqual(['query']);
    expect(parsed.rowsReturned).toBe(3);
    expect(parsed.rowsShown).toBe(3);
    expect(parsed.rows).toHaveLength(3);
  });

  it("format: 'json' with no rows still parses", async () => {
    const { scopedFetch } = makeRouter(() => Response.json({}));
    const result = await tool.execute({ site_url: SITE, format: 'json' }, makeCtx(scopedFetch));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.value);
    expect(parsed.rows).toEqual([]);
    expect(parsed.rowsReturned).toBe(0);
    expect(parsed.note).toContain('No data for');
  });

  it('routes a 403 with no reason to the grant message naming the property', async () => {
    const { scopedFetch } = makeRouter(() => new Response('not json', { status: 403 }));
    const result = await tool.execute({ site_url: SITE }, makeCtx(scopedFetch));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_available');
    expect(result.error).toContain(SITE);
    expect(result.error).toContain('Users and permissions');
  });
});
