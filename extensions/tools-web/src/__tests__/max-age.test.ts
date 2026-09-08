// The `max_age` duration grammar and its enforcers.
//
// CLAUDE.md §12 records that this repo has already shipped "a duration grammar
// validated nowhere". This file is the answer: the accept AND reject sets, the
// calendar-naive arithmetic (D13), the D4 widening invariant as a property, and
// D5's post-filter including the undated-hits limitation.

import { describe, expect, it } from 'vitest';
import {
  filterByMaxAge,
  MAX_AGE_GRAMMAR_HINT,
  type MaxAge,
  maxAgePhrase,
  maxAgeSince,
  parseMaxAge,
} from '../max-age';
import type { SearchHit } from '../search-backends';
import { searxngTimeRange } from '../search-backends';

/** Parse-or-throw, so tests read as durations rather than null checks. */
function age(value: string): MaxAge {
  const parsed = parseMaxAge(value);
  if (!parsed) throw new Error(`expected ${value} to parse`);
  return parsed;
}

const DAY_MS = 86_400_000;
/** A fixed instant so nothing here depends on when the suite runs. */
const NOW = Date.parse('2026-09-08T12:00:00.000Z');

describe('parseMaxAge — accepts', () => {
  it.each([
    ['1d', 1, 'd', 1],
    ['30d', 30, 'd', 30],
    ['2w', 2, 'w', 14],
    ['6m', 6, 'm', 180], // D13: 30-day months, NOT six calendar months
    ['1y', 1, 'y', 365],
    ['9999d', 9999, 'd', 9999],
  ] as const)('%s → n=%d unit=%s days=%d', (raw, n, unit, days) => {
    const parsed = age(raw);
    expect(parsed.n).toBe(n);
    expect(parsed.unit).toBe(unit);
    expect(parsed.days).toBe(days);
    expect(parsed.raw).toBe(raw);
  });

  it('trims and lowercases before matching', () => {
    expect(parseMaxAge(' 30D ')?.days).toBe(30);
    expect(parseMaxAge(' 30D ')?.raw).toBe('30d');
  });
});

describe('parseMaxAge — rejects (null, never a silently dropped filter)', () => {
  it.each([
    ['empty string', ''],
    ['whitespace', ' '],
    ['bare number string', '30'],
    ['bare unit', 'd'],
    ['zero quantity', '0d'], // an empty window no caller means
    ['negative', '-1d'],
    ['unknown unit', '30x'],
    ['five digits', '10000d'],
    ['fractional', '1.5m'],
    ['two durations', '30d 1w'],
  ])('%s', (_label, value) => {
    expect(parseMaxAge(value)).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['number', 30],
    ['object', { days: 30 }],
  ])('non-string: %s', (_label, value) => {
    expect(parseMaxAge(value)).toBeNull();
  });
});

describe('MAX_AGE_GRAMMAR_HINT', () => {
  it('names the grammar, not just the bad value — one string for every tool', () => {
    expect(MAX_AGE_GRAMMAR_HINT).toContain('max_age');
    expect(MAX_AGE_GRAMMAR_HINT).toContain('d|w|m|y');
  });
});

describe('maxAgeSince — calendar-naive cutoff (D13)', () => {
  it.each([
    ['1d', 1],
    ['2w', 14],
    ['6m', 180],
    ['1y', 365],
  ] as const)('%s is exactly %d days before now', (raw, days) => {
    expect(maxAgeSince(age(raw), NOW).getTime()).toBe(NOW - days * DAY_MS);
  });
});

describe('maxAgePhrase', () => {
  it('pluralizes on the quantity, not the unit', () => {
    expect(maxAgePhrase(age('30d'))).toBe('last 30 days');
    expect(maxAgePhrase(age('1d'))).toBe('last 1 day');
    expect(maxAgePhrase(age('1y'))).toBe('last 1 year');
    expect(maxAgePhrase(age('6m'))).toBe('last 6 months');
    expect(maxAgePhrase(age('2w'))).toBe('last 2 weeks');
  });
});

// ---------------------------------------------------------------------------
// D4, as a property: the window actually sent to SearXNG is NEVER narrower
// than the one requested. Narrowing loses results the caller asked for, and
// the loss is invisible — the caller cannot see what the provider withheld.
// ---------------------------------------------------------------------------

const BUCKET_DAYS = { day: 1, month: 31, year: 365 } as const;

describe('searxngTimeRange — never narrower than the request (D4)', () => {
  it('holds for every duration from 1d to 3650d', () => {
    const narrowed: string[] = [];
    for (let days = 1; days <= 3650; days++) {
      const bucket = searxngTimeRange(age(`${days}d`));
      if (bucket !== null && BUCKET_DAYS[bucket] < days) narrowed.push(`${days}d→${bucket}`);
    }
    expect(narrowed).toEqual([]);
  });

  it('holds for the other units too', () => {
    for (const raw of ['1w', '2w', '1m', '6m', '1y', '2y', '10y']) {
      const parsed = age(raw);
      const bucket = searxngTimeRange(parsed);
      if (bucket !== null) expect(BUCKET_DAYS[bucket]).toBeGreaterThanOrEqual(parsed.days);
    }
  });

  it.each([
    ['1d', 'day'],
    ['31d', 'month'],
    ['32d', 'year'],
    ['365d', 'year'],
    ['366d', null], // every bucket would narrow — send none at all (D7)
    ['2y', null],
  ] as const)('%s → %s', (raw, bucket) => {
    expect(searxngTimeRange(age(raw))).toBe(bucket);
  });
});

// ---------------------------------------------------------------------------
// D5 — the post-filter is the ENFORCER of the window; the provider parameter
// is only the request.
// ---------------------------------------------------------------------------

describe('filterByMaxAge', () => {
  const hit = (url: string, publishedDate?: string): SearchHit => ({
    url,
    ...(publishedDate === undefined ? {} : { publishedDate }),
  });

  it('drops a hit dated outside the window', () => {
    const hits = [hit('https://a/1', '2026-09-01'), hit('https://a/2', '2026-01-01')];
    expect(filterByMaxAge(hits, age('30d'), NOW).map((h) => h.url)).toEqual(['https://a/1']);
  });

  it('KEEPS hits with no readable date — the stated limitation', () => {
    const hits = [
      hit('https://a/none'),
      hit('https://a/empty', ''),
      hit('https://a/garbage', 'sometime last year'),
      hit('https://a/old', '2020-01-01'),
    ];
    expect(filterByMaxAge(hits, age('30d'), NOW).map((h) => h.url)).toEqual([
      'https://a/none',
      'https://a/empty',
      'https://a/garbage',
    ]);
  });

  it('keeps a hit dated exactly on the cutoff day', () => {
    const cutoff = maxAgeSince(age('30d'), NOW).toISOString().slice(0, 10);
    expect(filterByMaxAge([hit('https://a/edge', cutoff)], age('30d'), NOW)).toHaveLength(1);
  });

  it('reads the same date shapes the backends actually send', () => {
    const hits = [
      hit('https://exa', '2026-09-05T00:00:00Z'),
      hit('https://tavily', 'Mon, 07 Sep 2026 00:00:00 GMT'),
      hit('https://brave', '2026-09-06T12:34:56'),
      hit('https://stale', 'Mon, 09 Feb 2025 00:00:00 GMT'),
    ];
    expect(filterByMaxAge(hits, age('7d'), NOW).map((h) => h.url)).toEqual([
      'https://exa',
      'https://tavily',
      'https://brave',
    ]);
  });
});
