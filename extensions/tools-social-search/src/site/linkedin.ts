import {
  createSearxngBackend,
  type SearchHit,
  type SelectedBackend,
  selectSearchBackend,
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

  const lines = [`${index + 1}. **${heading}**${author ? ` — ${author}` : ''}`, `   ${hit.url}`];
  if (snippet && snippet !== heading) lines.push(`   ${snippet}`);
  return lines.join('\n');
}

export function createLinkedInSearchTool(opts: CreateLinkedInSearchToolOptions = {}): Tool {
  const searxng = opts.searxngUrl ? createSearxngBackend(opts.searxngUrl) : null;

  function selectBackend(ctx: ToolContext): SelectedBackend | null {
    const pid = ctx.personalityId;
    const setting =
      (pid ? opts.resolvePersonalitySetting?.(pid) : undefined) ??
      (pid ? opts.toolSettings?.[pid]?.web_search : undefined) ??
      opts.toolSettings?._default?.web_search;
    return selectSearchBackend({
      bindings: [setting],
      ...(opts.searchBackend ? { searchBackend: opts.searchBackend } : {}),
      searxng,
    });
  }

  return {
    name: 'linkedin_search',
    description:
      "Search public LinkedIn posts and articles via the personality's web-search backend, constrained to linkedin.com. Low-fidelity discovery, not a live-conversation source: no engagement counts, no follower counts, and no dates beyond what the backend returns. Shares the web_search credential binding rather than a key of its own.",
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
    // No settingsSchema (plan D3a) — deliberate, see quora_search.
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
      },
      required: ['query'],
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const { query, num_results } = args as { query: string; num_results?: number };
      if (!query) return { ok: false, error: 'query is required', code: 'input_invalid' };

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

      try {
        const hits =
          'searxng' in selected
            ? await selected.searxng.search(siteQuery, fetchCount, ctx)
            : await selected.backend.search(siteQuery, fetchCount, ctx, selected.secretRef);

        const filtered = filterAndDedupe(hits, LINKEDIN_PROFILE).slice(0, numResults);
        if (filtered.length === 0) {
          return { ok: true, value: `No results found for: ${query}` };
        }

        const formatted = filtered.map((hit, i) => formatHit(hit, i)).join('\n\n');
        return { ok: true, value: `LinkedIn posts for "${query}":\n\n${formatted}` };
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
