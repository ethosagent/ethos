import {
  createSearxngBackend,
  filterByMaxAge,
  MAX_AGE_GRAMMAR_HINT,
  maxAgePhrase,
  parseMaxAge,
  recencyLimitationNote,
  type SearchHit,
  type SelectedBackend,
  selectSearchBackend,
  toIsoDate,
  type WebSearchSetting,
} from '@ethosagent/tools-web';
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';
import { filterAndDedupe, LINKEDIN_PROFILE, overFetchCount } from './filter';

// ---------------------------------------------------------------------------
// linkedin_search — LinkedIn has no public post-search API at any partner
// tier (plan §1; SNAP is closed to new applicants), so this searches through
// the personality's EXISTING web_search backend, constrained to
// linkedin.com. Same D3a rationale as quora_search: no tools.yaml key of its
// own, shares the web_search binding.
//
// Low-fidelity discovery, documented as such (plan D11): it surfaces public
// /posts/ and /pulse/ URLs a search index happened to keep. It is never a
// live-conversation source and a consuming plugin must not rank it as one.
// See plan/phases/social-search-tools.md §6, §9, D3a, D11.
// ---------------------------------------------------------------------------

const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 10;
const SNIPPET_MAX_CHARS = 300;

// Mirrors web_search's own message (extensions/tools-web/src/index.ts) —
// not exported from there, so kept in sync by hand; both name the same fix.
const NO_BACKEND_MESSAGE =
  'No web search provider is configured. Add a key in Settings > Named Secrets and bind it to a provider in the personality tool settings, or set EXA_API_KEY, TAVILY_API_KEY, or BRAVE_API_KEY.';

// The settings-form counterpart of NO_BACKEND_MESSAGE: said BEFORE the refusal,
// where an operator looks for a tool's credentials, rather than after.
const BINDING_DISCLOSURE =
  "linkedin_search searches through this personality's web_search binding and has no key of its own by design, so there is nothing to bind here. Give web_search a provider and key — in this personality's tool settings, or under Settings > Web-search defaults — or set EXA_API_KEY, TAVILY_API_KEY or BRAVE_API_KEY in the environment; until one is set, every linkedin_search call refuses.";

export interface CreateLinkedInSearchToolOptions {
  searchBackend?: 'exa' | 'tavily' | 'brave';
  /** `web.searxng.url` — the same keyless rung web_search offers. */
  searxngUrl?: string;
  /** Reads the personality's EXISTING `web_search` binding (plan D3a) — this
   *  tool has no tools.yaml key of its own. */
  resolvePersonalitySetting?: (personalityId: string) => WebSearchSetting | undefined;
  /** Global FALLBACK map keyed by personalityId or `_default`, same shape
   *  web_search reads. */
  toolSettings?: Record<string, { web_search?: WebSearchSetting } | undefined>;
}

function clampInt(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), max);
}

/** Some search backends title a LinkedIn post hit "<Name> on LinkedIn: <post
 *  text>" — when a hit's title carries that shape, split out the author. No
 *  field is invented when it doesn't (plan D10): a hit with no such title
 *  just renders without an author line. */
const TITLE_AUTHOR_RE = /^(.+?)\s+on LinkedIn:\s*(.+)$/i;

function firstLine(text: string | undefined): string | null {
  const line = text?.split('\n')[0]?.trim();
  return line || null;
}

function formatHit(hit: SearchHit, index: number): string {
  const rawTitle = hit.title?.trim();
  const match = rawTitle?.match(TITLE_AUTHOR_RE);
  const author = match?.[1];
  const heading = match ? match[2] : rawTitle || firstLine(hit.text) || 'Untitled post';
  const snippet = hit.text?.trim().slice(0, SNIPPET_MAX_CHARS) ?? '';
  // ` (YYYY-MM-DD)` closes the heading line, or nothing at all when the backend
  // supplied no readable date — `toIsoDate` never invents one (plan D10).
  const iso = toIsoDate(hit.publishedDate);

  const lines = [
    `${index + 1}. **${heading}**${author ? ` — ${author}` : ''}${iso ? ` (${iso})` : ''}`,
    `   ${hit.url}`,
  ];
  if (snippet && snippet !== heading) lines.push(`   ${snippet}`);
  return lines.join('\n');
}

export function createLinkedInSearchTool(opts: CreateLinkedInSearchToolOptions = {}): Tool {
  const searxng = opts.searxngUrl ? createSearxngBackend(opts.searxngUrl) : null;

  // web_search's binding, read WHOLE (plan D3a — this tool has no key of its
  // own): `provider`/`secret` pick the backend, `recency` is the stored
  // `max_age` default. Same rung shape as quora_search's own resolveSetting.
  function resolveSetting(ctx: ToolContext): WebSearchSetting | undefined {
    const pid = ctx.personalityId;
    return (
      (pid ? opts.resolvePersonalitySetting?.(pid) : undefined) ??
      (pid ? opts.toolSettings?.[pid]?.web_search : undefined) ??
      opts.toolSettings?._default?.web_search
    );
  }

  function selectBackend(ctx: ToolContext): SelectedBackend | null {
    return selectSearchBackend({
      bindings: [resolveSetting(ctx)],
      ...(opts.searchBackend ? { searchBackend: opts.searchBackend } : {}),
      searxng,
    });
  }

  return {
    name: 'linkedin_search',
    description:
      "Search public LinkedIn posts and articles via the personality's web-search backend, constrained to linkedin.com. Low-fidelity discovery, not a live-conversation source: no engagement counts and no follower counts. A post's publication date is rendered as ISO YYYY-MM-DD when the backend supplied one, and omitted entirely when it did not; a missing date is never guessed. Optionally restrict results to a recency window with max_age, a duration like 30d, 6m or 1y; omit it for no recency filter. Shares the web_search credential binding rather than a key of its own.",
    toolset: 'web',
    maxResultChars: 15_000,
    capabilities: {
      network: {
        allowedHosts: [
          'api.exa.ai',
          'api.tavily.com',
          'api.search.brave.com',
          ...(searxng ? [searxng.host] : []),
        ],
      },
      secrets: ['providers/exa/*', 'providers/tavily/*', 'providers/brave/*'],
    },
    outputIsUntrusted: true,
    // No `secret-binding` field (plan D3a) — deliberate, see quora_search;
    // one read-only `info` field discloses the web_search binding it reads.
    settingsSchema: {
      fields: [{ kind: 'info', label: 'Web search credential', text: BINDING_DISCLOSURE }],
    },
    isAvailable() {
      return true;
    },
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        num_results: {
          type: 'number',
          description: `Number of posts to return (default ${DEFAULT_NUM_RESULTS}, max ${MAX_NUM_RESULTS})`,
        },
        max_age: {
          type: 'string',
          description:
            'Only return posts published within this window, as a duration: <number><d|w|m|y>, e.g. 30d, 2w, 6m, 1y. Omit for no recency filter.',
        },
      },
      required: ['query'],
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const { query, num_results, max_age } = args as {
        query: string;
        num_results?: number;
        max_age?: string;
      };
      if (!query) return { ok: false, error: 'query is required', code: 'input_invalid' };

      // Refused, not ignored: an unparseable window that quietly fell through
      // would return unfiltered results to a caller who believes it filtered.
      const argMaxAge = max_age === undefined ? null : parseMaxAge(max_age);
      if (max_age !== undefined && !argMaxAge) {
        return {
          ok: false,
          error: `${MAX_AGE_GRAMMAR_HINT} (got ${JSON.stringify(max_age)})`,
          code: 'input_invalid',
        };
      }

      const secrets = ctx.secretsResolver;
      const net = ctx.scopedFetch;
      if (!secrets || !net) {
        return {
          ok: false,
          error: 'Capability backends not configured',
          code: 'not_available' as const,
        };
      }

      const selected = selectBackend(ctx);
      if (!selected) {
        return { ok: false, error: NO_BACKEND_MESSAGE, code: 'not_available' as const };
      }

      const numResults = clampInt(num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
      const fetchCount = overFetchCount(numResults);
      // The site: operator is a hint (not every backend honours it) — the
      // filter below is the actual guarantee (plan §9).
      const siteQuery = `${query} ${LINKEDIN_PROFILE.siteOperator}`;

      // Precedence: call argument → the shared binding's `recency` → unset. An
      // invalid STORED value is ignored where an invalid call argument is
      // refused above; `web_search` (extensions/tools-web/src/index.ts) is the
      // canonical implementation and carries the reasoning for that asymmetry.
      const maxAge = argMaxAge ?? parseMaxAge(resolveSetting(ctx)?.recency);
      const options = maxAge ? { maxAge } : undefined;

      try {
        const providerId = 'searxng' in selected ? selected.searxng.id : selected.backend.id;
        const hits =
          'searxng' in selected
            ? await selected.searxng.search(siteQuery, fetchCount, ctx, options)
            : await selected.backend.search(
                siteQuery,
                fetchCount,
                ctx,
                selected.secretRef,
                options,
              );

        // The window is enforced HERE, not by the provider parameter — see
        // `filterByMaxAge`. It runs AFTER filterAndDedupe and BEFORE the final
        // slice on purpose: this tool over-fetches, so trimming out-of-window
        // hits first lets in-window hits further down the over-fetched list
        // fill the caller's num_results, instead of the window silently
        // shortening the list while in-window hits were available.
        const deduped = filterAndDedupe(hits, LINKEDIN_PROFILE);
        const filtered = (maxAge ? filterByMaxAge(deduped, maxAge) : deduped).slice(0, numResults);
        if (filtered.length === 0) {
          // The window is named because a model that has forgotten it set a
          // filter reads a bare "no results" as a fact about the web, and its
          // next move is to rephrase the query rather than to widen the window.
          return {
            ok: true,
            value: maxAge
              ? `No results found for: ${query} in the ${maxAgePhrase(maxAge)} (via ${providerId})`
              : `No results found for: ${query}`,
          };
        }

        const formatted = filtered.map((hit, i) => formatHit(hit, i)).join('\n\n');
        const window = maxAge ? ` — ${maxAgePhrase(maxAge)}` : '';
        const note = maxAge ? recencyLimitationNote(providerId, maxAge) : null;
        const header = `LinkedIn posts for "${query}"${window}:`;
        return { ok: true, value: `${header}${note ? `\nNote: ${note}.` : ''}\n\n${formatted}` };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      }
    },
  };
}

export const linkedInSearchTool = createLinkedInSearchTool();
