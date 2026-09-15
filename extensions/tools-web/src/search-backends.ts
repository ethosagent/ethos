import type { SecretRef, ToolContext } from '@ethosagent/types';
import { type MaxAge, maxAgePhrase, maxAgeSince } from './max-age';

// ---------------------------------------------------------------------------
// Search backend contract — one per provider (Exa, Tavily, Brave)
// ---------------------------------------------------------------------------

export interface SearchHit {
  title?: string;
  url: string;
  text?: string;
  publishedDate?: string;
}

/** Actionable "no key" message naming the provider and where to set one. */
const NO_KEY_MESSAGE = (provider: 'exa' | 'tavily' | 'brave'): string =>
  `No ${provider} key configured — add one in Settings > Named Secrets (or set the ${provider.toUpperCase()}_API_KEY env var).`;

// ---------------------------------------------------------------------------
// Recency — one tool-facing duration (`max_age`, e.g. `30d` / `6m` / `1y`),
// mapped to each backend's own native parameter.
//
// A duration rather than a closed enum because three of the four backends take
// an ABSOLUTE instant, so an arbitrary window survives them exactly: Exa's
// `startPublishedDate` (ISO 8601), Tavily's `start_date` (`YYYY-MM-DD`), and
// Brave's `freshness` in its `YYYY-MM-DDtoYYYY-MM-DD` range form. Only SearXNG
// is bucket-only (`day`/`month`/`year`), and its widening is both bounded
// (never narrower than requested) and disclosed (`recencyLimitationNote`), with
// `filterByMaxAge` in ./max-age.ts trimming the superset locally.
//
// Every parameter name below was confirmed against the provider's own current
// docs, because a wrong name FAILS SILENTLY: the provider ignores the unknown
// field and returns unfiltered results while the caller believes the filter is
// on. Doc URLs are on each mapping.
// ---------------------------------------------------------------------------

export interface SearchOptions {
  /**
   * Only return results published within this window. Absent means no recency
   * filter AND a request byte-identical to the one this code sent before the
   * option existed — no backend adds an empty parameter.
   */
  maxAge?: MaxAge;
  /**
   * The caller's per-hit excerpt length (`web_search`'s `max_chars`, already
   * clamped). Only Exa takes a length parameter, so only Exa reads it: it asks
   * for `max(1500, maxChars)`, which is 1500 — today's request — for every
   * value up to 1500. Tavily, Brave and SearXNG return what they return and
   * the formatter cuts it.
   */
  maxChars?: number;
}

/** Cutoff (and today) as `YYYY-MM-DD`, the shape Tavily and Brave both want. */
function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Exa: `startPublishedDate`, an ISO 8601 date-time — "Only links with a
 * published date after this will be returned".
 * https://exa.ai/docs/reference/search
 * (`startCrawlDate`/`endCrawlDate` are documented as deprecated and ignored.)
 */
export function exaStartPublishedDate(maxAge: MaxAge, now: number = Date.now()): string {
  return maxAgeSince(maxAge, now).toISOString();
}

/**
 * Tavily: `start_date`, a `YYYY-MM-DD` publication-date floor. Documented
 * alongside `end_date` and the coarser `time_range` bucket — the dated form is
 * used because it expresses any duration exactly, where `time_range` would have
 * to bucket `6m` into `year`.
 * https://docs.tavily.com/documentation/api-reference/endpoint/search
 *
 * Tavily matches on publish date OR LAST-UPDATED date (its own doc wording, for
 * all three parameters), so a stale page re-touched yesterday matches a `7d`
 * window. That is a property of the backend rather than of any one request, so
 * it is disclosed once in `web_search`'s tool description — not per call.
 */
export function tavilyStartDate(maxAge: MaxAge, now: number = Date.now()): string {
  return ymd(maxAgeSince(maxAge, now));
}

/**
 * Brave: `freshness` — either a `pd`/`pw`/`pm`/`py` bucket or a custom
 * `YYYY-MM-DDtoYYYY-MM-DD` range. The range form is used because it expresses
 * any duration exactly to day granularity; the buckets could only approximate
 * one.
 * https://api-dashboard.search.brave.com/app/documentation/web-search/query
 */
export function braveFreshness(maxAge: MaxAge, now: number = Date.now()): string {
  return `${ymd(maxAgeSince(maxAge, now))}to${ymd(new Date(now))}`;
}

/**
 * SearXNG: `time_range` — the API documents `day`, `month`, `year` ONLY; there
 * is no `week` and no date form. https://docs.searxng.org/dev/search_api.html
 *
 * The only genuinely bucket-only backend, so it is the only one that has to
 * approximate. It approximates in ONE direction: the bucket sent is never
 * narrower than the requested window. Widening returns a superset that
 * `filterByMaxAge` trims exactly; narrowing would silently lose results the
 * caller asked for, invisibly, because the caller cannot see what the provider
 * withheld.
 *
 * Past a year every available bucket would narrow, so `null` means "send no
 * `time_range` at all" — the search runs unfiltered upstream and the local
 * filter carries the whole window. Refusing the search instead would throw away
 * a usable answer over a granularity the local filter recovers exactly.
 *
 * Both approximations are disclosed by `recencyLimitationNote`.
 */
export function searxngTimeRange(maxAge: MaxAge): 'day' | 'month' | 'year' | null {
  if (maxAge.days <= 1) return 'day';
  if (maxAge.days <= 31) return 'month';
  if (maxAge.days <= 365) return 'year';
  return null;
}

/** Days each SearXNG bucket actually covers — `month` is 31 and `year` 365, so
 *  a request of exactly 1/31/365 days is expressed exactly and needs no note. */
const SEARXNG_BUCKET_DAYS: Record<'day' | 'month' | 'year', number> = {
  day: 1,
  month: 31,
  year: 365,
};

/**
 * A sentence for the rendered output when the chosen backend could not express
 * the requested window exactly, or `null` when it could. Kept beside the
 * mapping tables above on purpose — the two must not drift.
 *
 * Exa, Tavily and Brave all take an absolute instant, so they are always exact
 * and always return `null`. SearXNG has two inexact cases: a widened bucket,
 * and a window past a year that is not expressed upstream at all.
 */
export function recencyLimitationNote(
  backendId: SearchBackend['id'] | KeylessSearchBackend['id'],
  maxAge: MaxAge,
): string | null {
  if (backendId !== 'searxng') return null;
  const bucket = searxngTimeRange(maxAge);
  if (bucket === null) {
    return `the searxng backend's widest window is 'year', so the ${maxAgePhrase(
      maxAge,
    )} could not be requested upstream at all and was applied here instead; results carrying no publication date are included`;
  }
  if (SEARXNG_BUCKET_DAYS[bucket] === maxAge.days) return null;
  return `the searxng backend only offers day/month/year windows, so the ${maxAgePhrase(
    maxAge,
  )} was requested upstream as '${bucket}' and narrowed here; results carrying no publication date are included`;
}

/**
 * `toIsoDate` lives in ./max-age.ts (its primary consumer is `filterByMaxAge`)
 * and is re-exported here, where every backend's date handling is documented,
 * so existing importers are unaffected.
 */
export { toIsoDate } from './max-age';

export interface SearchBackend {
  id: 'exa' | 'tavily' | 'brave';
  host: string;
  secretRef: SecretRef;
  isAvailable(): boolean;
  /**
   * `secretRef` is the resolved secret reference for this call — the default
   * `providers/<id>/apiKey`, or a personality-bound `providers/<id>/<name>`
   * named secret. The caller (`selectBackend`) resolves it; the backend only
   * reads the ref it is handed.
   *
   * `options.maxAge` maps to the backend's own recency parameter. Omitted
   * (or absent) leaves the request exactly as it was before the option existed.
   */
  search(
    query: string,
    numResults: number,
    ctx: ToolContext,
    secretRef: SecretRef,
    options?: SearchOptions,
  ): Promise<SearchHit[]>;
}

// ---------------------------------------------------------------------------
// Exa — POST https://api.exa.ai/search
// ---------------------------------------------------------------------------

export const exaBackend: SearchBackend = {
  id: 'exa',
  host: 'api.exa.ai',
  secretRef: 'providers/exa/apiKey',
  isAvailable: () => Boolean(process.env.EXA_API_KEY),
  async search(query, numResults, ctx, secretRef, options): Promise<SearchHit[]> {
    const apiKey = await ctx.secretsResolver?.get(secretRef);
    if (!apiKey) throw new Error(NO_KEY_MESSAGE('exa'));
    const net = ctx.scopedFetch;
    if (!net) throw new Error('scopedFetch not configured');

    const body: Record<string, unknown> = {
      query,
      numResults,
      contents: { text: { maxCharacters: Math.max(1500, options?.maxChars ?? 0) } },
    };
    if (options?.maxAge) body.startPublishedDate = exaStartPublishedDate(options.maxAge);

    const response = await net.fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(body),
      signal: ctx.abortSignal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Exa API error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as {
      results: Array<{ title?: string; url: string; text?: string; publishedDate?: string }>;
    };
    return data.results ?? [];
  },
};

// ---------------------------------------------------------------------------
// Tavily — POST https://api.tavily.com/search
// ---------------------------------------------------------------------------

export const tavilyBackend: SearchBackend = {
  id: 'tavily',
  host: 'api.tavily.com',
  secretRef: 'providers/tavily/apiKey',
  isAvailable: () => Boolean(process.env.TAVILY_API_KEY),
  async search(query, numResults, ctx, secretRef, options): Promise<SearchHit[]> {
    const apiKey = await ctx.secretsResolver?.get(secretRef);
    if (!apiKey) throw new Error(NO_KEY_MESSAGE('tavily'));
    const net = ctx.scopedFetch;
    if (!net) throw new Error('scopedFetch not configured');

    const response = await net.fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: numResults,
        include_answer: false,
        search_depth: 'basic',
        // `start_date`, not the coarser `time_range` bucket — see
        // `tavilyStartDate` above.
        ...(options?.maxAge ? { start_date: tavilyStartDate(options.maxAge) } : {}),
      }),
      signal: ctx.abortSignal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Tavily API error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as {
      results?: Array<{ title?: string; url: string; content?: string; published_date?: string }>;
    };
    return (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      text: r.content,
      publishedDate: r.published_date,
    }));
  },
};

// ---------------------------------------------------------------------------
// Brave — GET https://api.search.brave.com/res/v1/web/search
// ---------------------------------------------------------------------------

export const braveBackend: SearchBackend = {
  id: 'brave',
  host: 'api.search.brave.com',
  secretRef: 'providers/brave/apiKey',
  isAvailable: () => Boolean(process.env.BRAVE_API_KEY),
  async search(query, numResults, ctx, secretRef, options): Promise<SearchHit[]> {
    const apiKey = await ctx.secretsResolver?.get(secretRef);
    if (!apiKey) throw new Error(NO_KEY_MESSAGE('brave'));
    const net = ctx.scopedFetch;
    if (!net) throw new Error('scopedFetch not configured');

    const freshness = options?.maxAge ? braveFreshness(options.maxAge) : null;
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
      query,
    )}&count=${numResults}${freshness ? `&freshness=${freshness}` : ''}`;
    const response = await net.fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
      signal: ctx.abortSignal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Brave API error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as {
      web?: {
        results?: Array<{ title?: string; url: string; description?: string; page_age?: string }>;
      };
    };
    return (data.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      text: r.description,
      publishedDate: r.page_age,
    }));
  },
};

export const ALL_BACKENDS: SearchBackend[] = [exaBackend, tavilyBackend, braveBackend];

// ---------------------------------------------------------------------------
// SearXNG — GET <instance>/search?q=…&format=json
// ---------------------------------------------------------------------------

/**
 * A self-hosted metasearch instance. Deliberately NOT a `SearchBackend`: it
 * takes no API key, so it has no `secretRef` and its `search` has nothing to
 * do with the vault. Giving it a ref it never resolves would put a dead
 * namespace in `web_search`'s capability grant.
 */
export interface KeylessSearchBackend {
  id: 'searxng';
  host: string;
  search(
    query: string,
    numResults: number,
    ctx: ToolContext,
    options?: SearchOptions,
  ): Promise<SearchHit[]>;
}

/**
 * Build the SearXNG rung for `web.searxng.url`. Returns `null` for a URL that
 * is not parseable — the rung is simply not offered, exactly as if it were
 * unconfigured, rather than failing every later search.
 */
export function createSearxngBackend(instanceUrl: string): KeylessSearchBackend | null {
  let base: URL;
  try {
    base = new URL(instanceUrl);
  } catch {
    return null;
  }
  const endpoint = new URL('search', base.href.endsWith('/') ? base.href : `${base.href}/`);

  return {
    id: 'searxng',
    host: base.host,
    async search(query, numResults, ctx, options): Promise<SearchHit[]> {
      const net = ctx.scopedFetch;
      if (!net) throw new Error('scopedFetch not configured');

      const url = new URL(endpoint.href);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      // The bucket is never narrower than the request, and past a year there
      // is no bucket at all — the caller renders `recencyLimitationNote` so
      // neither approximation is silent. See `searxngTimeRange`.
      const bucket = options?.maxAge ? searxngTimeRange(options.maxAge) : null;
      if (bucket) url.searchParams.set('time_range', bucket);

      let response: Response;
      try {
        response = await net.fetch(url.href, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: ctx.abortSignal,
        });
      } catch (err) {
        // A self-hosted endpoint being down or misspelled is the expected
        // failure here, and a bare "fetch failed" names nothing the operator
        // can fix. Say which instance.
        throw new Error(
          `SearXNG instance ${base.host} is unreachable (web.searxng.url): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`SearXNG error ${response.status} from ${base.host}: ${body}`);
      }

      const data = (await response.json()) as {
        results?: Array<{
          title?: string;
          url: string;
          content?: string;
          publishedDate?: string;
        }>;
      };
      return (data.results ?? []).slice(0, numResults).map((r) => ({
        title: r.title,
        url: r.url,
        text: r.content,
        publishedDate: r.publishedDate,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// selectSearchBackend — the provider-agnostic tail of backend resolution.
//
// Any tool that dispatches over these same three keyed backends (web_search
// today; quora_search / linkedin_search later) needs the same rungs 4-6:
// an explicit provider choice, then the construction-time preference (if
// available), then the first available backend, then the keyless SearXNG
// rung. Rungs 1-3 — which key names the binding, e.g. `web_search` vs.
// `quora_search` in a personality's tools.yaml / toolSettings — are
// tool-specific and stay a local `??` chain at each call site (tools that
// resolve a bare secret ref instead share `resolveToolSecretRef`,
// packages/core/src/tool-secret-ref.ts). This function only takes the
// already-resolved result of that chain, as an ordered list where the first
// defined entry wins.
// ---------------------------------------------------------------------------

/** The shape of a resolved provider+secret binding, independent of which
 *  tool's tools.yaml key produced it. `WebSearchSetting` in ./index.ts is
 *  structurally identical and is passed here without conversion. */
export interface SearchProviderBinding {
  provider?: SearchBackend['id'];
  secret?: string;
}

export type SelectedBackend =
  | { backend: SearchBackend; secretRef: SecretRef }
  | { searxng: KeylessSearchBackend };

export interface SelectBackendInput {
  /** The tool's binding layers, most specific first — e.g. [personality
   *  tools.yaml, toolSettings[personalityId], toolSettings._default]. The
   *  first defined entry wins, exactly like the `??` chain it replaces. */
  bindings: ReadonlyArray<SearchProviderBinding | undefined>;
  /** Construction-time preference, honoured only when available (backward
   *  compat with tools built before per-personality bindings existed). */
  searchBackend?: SearchBackend['id'];
  /** The keyless SearXNG rung, or null/undefined when not configured. */
  searxng?: KeylessSearchBackend | null;
}

export function selectSearchBackend(input: SelectBackendInput): SelectedBackend | null {
  const { bindings, searchBackend, searxng } = input;
  const setting = bindings.find((b) => b !== undefined);

  if (setting?.provider) {
    const backend = ALL_BACKENDS.find((b) => b.id === setting.provider);
    if (backend) {
      const name = setting.secret?.trim();
      const secretRef: SecretRef = name ? `providers/${backend.id}/${name}` : backend.secretRef;
      return { backend, secretRef };
    }
  }

  // Backward compat: construction-time preference, then first-available.
  if (searchBackend) {
    const pref = ALL_BACKENDS.find((b) => b.id === searchBackend);
    if (pref?.isAvailable()) return { backend: pref, secretRef: pref.secretRef };
  }
  const first = ALL_BACKENDS.find((b) => b.isAvailable());
  if (first) return { backend: first, secretRef: first.secretRef };
  return searxng ? { searxng } : null;
}
