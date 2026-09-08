import type { SearchHit } from './search-backends';

// ---------------------------------------------------------------------------
// max_age — the recency duration grammar, and its ONLY enforcer.
//
// One module owns the grammar, the arithmetic, the wording and the post-filter,
// because CLAUDE.md §12 records that this repo has already shipped "a duration
// grammar validated nowhere". Nothing else parses a `max_age`; nothing else
// decides what "the last 30 days" means; nothing else drops an out-of-window
// hit. Every symbol here is pinned by `__tests__/max-age.test.ts`.
// ---------------------------------------------------------------------------

export type MaxAgeUnit = 'd' | 'w' | 'm' | 'y';

/**
 * Days per unit. Deliberately CALENDAR-NAIVE: `m` is 30 days and `y` is 365,
 * never "six calendar months" or "one calendar year".
 *
 * A calendar-aware `6m` lands on a different instant depending on which months
 * it crossed (and on DST, and on whether a leap day fell inside), so the same
 * argument would mean a different window on different days — unpredictable to
 * the caller and awkward to pin in a test. Naive arithmetic makes the cutoff a
 * pure function of (duration, now).
 *
 * This differs from the deleted `TIME_RANGE_DAYS`, which used `month: 31` to
 * match Brave's documented `pm` bucket ("last 31 days"). That bucket is no
 * longer used — Brave now receives an explicit date range — so nothing depends
 * on 31, and 30 is the number a caller means by "a month".
 */
const UNIT_DAYS: Record<MaxAgeUnit, number> = { d: 1, w: 7, m: 30, y: 365 };

const UNIT_NOUN: Record<MaxAgeUnit, string> = { d: 'day', w: 'week', m: 'month', y: 'year' };

const DAY_MS = 86_400_000;

/** A parsed, validated recency window. Only `parseMaxAge` constructs one, so a
 *  value of this type has already passed the grammar. */
export interface MaxAge {
  /** The quantity. Always >= 1. */
  readonly n: number;
  readonly unit: MaxAgeUnit;
  /** Resolved window length in days (calendar-naive, see `UNIT_DAYS`). */
  readonly days: number;
  /** The caller's value, trimmed and lowercased. */
  readonly raw: string;
}

/**
 * The one refusal string. Every tool that takes a `max_age` uses this exact
 * text, so a caller cannot learn the grammar from one tool and be refused in
 * different words by another.
 */
export const MAX_AGE_GRAMMAR_HINT =
  'max_age must be a duration like 30d, 6m or 1y (<number><d|w|m|y>)';

const MAX_AGE_PATTERN = /^(\d{1,4})([dwmy])$/;

/**
 * Parse a `max_age` value. `null` for anything the grammar does not accept —
 * including a non-string, and including a zero quantity, since `0d` names an
 * empty window no caller means.
 *
 * The value is trimmed and lowercased first, so `' 30D '` parses as `30d`.
 * Callers surface `null` as `input_invalid` naming `MAX_AGE_GRAMMAR_HINT`;
 * they never fall through to an unfiltered search, because a silently dropped
 * filter returns unfiltered results to a caller who believes one is on.
 */
export function parseMaxAge(value: unknown): MaxAge | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  const match = MAX_AGE_PATTERN.exec(raw);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2] as MaxAgeUnit;
  if (!Number.isFinite(n) || n < 1) return null;
  return { n, unit, days: n * UNIT_DAYS[unit], raw };
}

/** The absolute cutoff instant: nothing older than this is in the window. */
export function maxAgeSince(maxAge: MaxAge, now: number = Date.now()): Date {
  return new Date(now - maxAge.days * DAY_MS);
}

/** Human phrasing for headers and the empty-result line — `last 30 days`,
 *  `last 1 year`. Singular at `n === 1`. */
export function maxAgePhrase(maxAge: MaxAge): string {
  const noun = UNIT_NOUN[maxAge.unit];
  return `last ${maxAge.n} ${noun}${maxAge.n === 1 ? '' : 's'}`;
}

/**
 * A hit's published date as ISO `YYYY-MM-DD`, or `null` when the backend
 * supplied none or supplied one that cannot be read.
 *
 * Never invents, defaults, or substitutes today: a missing date stays visibly
 * missing, because a downstream consumer treats a PRESENT date as trustworthy
 * (a fabricated one would keep a stale item inside a retention window forever).
 * Normalizing rather than slicing matters because the backends disagree — Exa
 * sends `2024-01-02T00:00:00Z`, Tavily can send RFC 1123
 * (`Mon, 09 Feb 2025 00:00:00 GMT`), and a blind `slice(0, 10)` turns the
 * second into `Mon, 09 F`.
 *
 * Lives here rather than in `search-backends.ts` (which re-exports it, so
 * existing importers are unaffected) because `filterByMaxAge` below is its
 * primary consumer and `max-age.ts` must not take a runtime dependency on the
 * backends module — its only import from there is a type, which erases.
 */
export function toIsoDate(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const alreadyIso = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (alreadyIso?.[1]) return alreadyIso[1];
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

/**
 * THE ENFORCER of the window. The provider parameter is only the request; this
 * is what makes the guarantee true, and it is what carries the whole window on
 * a backend whose own filter is coarse (SearXNG) or absent (SearXNG past a
 * year, where no upstream window is sent at all).
 *
 * The guarantee is exactly: **no hit with a readable publication date outside
 * the window is returned.**
 *
 * **Hits with no readable date are KEPT.** This is a limitation, written down
 * as one rather than papered over: Brave's `page_age` and SearXNG's
 * `publishedDate` are frequently absent, and Exa and Tavily both omit the field
 * for pages whose publish date their index never resolved. Dropping undated
 * hits would empty the result set — often to zero, and worst exactly where the
 * provider-side filter is weakest — to enforce a guarantee the data cannot
 * support. Undated hits are therefore neither filtered nor claimed to be
 * in-window; `recencyLimitationNote` (search-backends.ts) discloses their
 * inclusion on any approximated backend.
 *
 * Comparison is day-granular, matching what the backends actually report
 * (Tavily and Brave are day-granular themselves), and a hit dated exactly on
 * the cutoff day is kept.
 */
export function filterByMaxAge(
  hits: readonly SearchHit[],
  maxAge: MaxAge,
  now: number = Date.now(),
): SearchHit[] {
  const cutoff = maxAgeSince(maxAge, now).toISOString().slice(0, 10);
  return hits.filter((hit) => {
    const iso = toIsoDate(hit.publishedDate);
    return iso === null || iso >= cutoff;
  });
}
