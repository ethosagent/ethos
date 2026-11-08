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
  type WebSearchSetting,
} from '@ethosagent/tools-web';
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';
import { filterAndDedupe, overFetchCount, type SiteProfile } from './filter';

// ---------------------------------------------------------------------------
// createSiteSearchTool — the one implementation behind linkedin_search,
// quora_search and reddit_web_search. None of those platforms is reachable
// through an API here, so each tool searches through the personality's
// EXISTING web_search backend (Exa/Tavily/Brave, or SearXNG) constrained to one
// site (plan D3a): no tools.yaml key of its own, and the shared binding is a
// disclosure — an operator sees the tool draw on the web_search credential and
// learns, from the configuration itself, that these hits carry search fidelity
// (a publication date only when the search index happened to record one), not
// the structured fidelity of a first-class platform API. A site is a
// `SiteSearchSpec`; what differs between them (name, description, hit
// rendering, site profile) lives in the spec. See
// plan/phases/social-search-tools.md §6, §9, D3a, D10, D11.
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
function bindingDisclosure(toolName: string): string {
  return `${toolName} searches through this personality's web_search binding and has no key of its own by design, so there is nothing to bind here. Give web_search a provider and key — in this personality's tool settings, or under Settings > Web-search defaults — or set EXA_API_KEY, TAVILY_API_KEY or BRAVE_API_KEY in the environment; until one is set, every ${toolName} call refuses.`;
}

export interface SiteSearchToolOptions {
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

export interface SiteSearchSpec {
  /** The tool name the model sees, e.g. `quora_search`. */
  name: string;
  /** The full tool description the model sees. */
  description: string;
  /** What a hit is called in the schema text: `posts` or `questions`. */
  noun: string;
  /** Result header up to ` for "<query>"`, e.g. `Quora questions`. */
  headerLabel: string;
  /** The site filter and URL shape for `filterAndDedupe`. */
  profile: SiteProfile;
  /** Renders one hit; site-specific (author, subreddit, untitled label). */
  formatHit: (hit: SearchHit, index: number) => string;
}

/** A hit's text trimmed to the snippet length; empty when the backend sent none. */
export function hitSnippet(hit: SearchHit): string {
  return hit.text?.trim().slice(0, SNIPPET_MAX_CHARS) ?? '';
}

function clampInt(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), max);
}

export function createSiteSearchTool(spec: SiteSearchSpec, opts: SiteSearchToolOptions = {}): Tool {
  const searxng = opts.searxngUrl ? createSearxngBackend(opts.searxngUrl) : null;

  // web_search's binding, read WHOLE (plan D3a — this tool has no key of its
  // own): `provider`/`secret` pick the backend, `recency` is the stored
  // `max_age` default. Same rung shape as web_search's own resolveSetting
  // (extensions/tools-web/src/index.ts): rungs 1-3 (which key names the
  // binding) are tool-specific and stay a local `??` chain; rungs 4-6 live
  // in the shared `selectSearchBackend`.
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
    name: spec.name,
    description: spec.description,
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
    // Deliberately no `secret-binding` field (plan D3a): this tool has no
    // tools.yaml key of its own, it reads web_search's existing binding, so a
    // picker here would look functional and bind a key nothing reads. What it
    // declares instead is one read-only `info` field — otherwise an operator
    // holding this tool without web_search in the same toolset sees no
    // credential requirement anywhere, then meets NO_BACKEND_MESSAGE.
    settingsSchema: {
      fields: [
        { kind: 'info', label: 'Web search credential', text: bindingDisclosure(spec.name) },
      ],
    },
    // Always registered — the vault is not visible at filter time (no
    // ToolContext in isAvailable). execute() surfaces a clear "no provider
    // configured" error. Same reasoning as web_search / the YouTube pair.
    isAvailable() {
      return true;
    },
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        num_results: {
          type: 'number',
          description: `Number of ${spec.noun} to return (default ${DEFAULT_NUM_RESULTS}, max ${MAX_NUM_RESULTS})`,
        },
        max_age: {
          type: 'string',
          description: `Only return ${spec.noun} published within this window, as a duration: <number><d|w|m|y>, e.g. 30d, 2w, 6m, 1y. Omit for no recency filter.`,
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
      const siteQuery = `${query} ${spec.profile.siteOperator}`;

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
        const deduped = filterAndDedupe(hits, spec.profile);
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

        const formatted = filtered.map((hit, i) => spec.formatHit(hit, i)).join('\n\n');
        const window = maxAge ? ` — ${maxAgePhrase(maxAge)}` : '';
        const note = maxAge ? recencyLimitationNote(providerId, maxAge) : null;
        const header = `${spec.headerLabel} for "${query}"${window}:`;
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
