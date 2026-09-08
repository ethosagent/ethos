import {
  createSearxngBackend,
  type SearchHit,
  type SelectedBackend,
  selectSearchBackend,
  type WebSearchSetting,
} from '@ethosagent/tools-web';
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';
import { filterAndDedupe, overFetchCount, QUORA_PROFILE } from './filter';

// ---------------------------------------------------------------------------
// quora_search — Quora has no API at any tier (plan §1), so this searches
// through the personality's EXISTING web_search backend (Exa/Tavily/Brave,
// or SearXNG) constrained to quora.com. No tools.yaml key of its own (plan
// D3a): a personality that already binds web_search gets Quora search for
// free, and the shared binding is a disclosure — an operator sees
// quora_search draw on the web_search credential and learns, from the
// configuration itself, that these hits carry search fidelity (no answer
// counts, no vote counts, no dates beyond what the backend returns), not the
// structured fidelity of a first-class platform API. See
// plan/phases/social-search-tools.md §6, §9, D3a.
// ---------------------------------------------------------------------------

const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 10;
const SNIPPET_MAX_CHARS = 300;

// Mirrors web_search's own message (extensions/tools-web/src/index.ts) —
// not exported from there, so kept in sync by hand; both name the same fix.
const NO_BACKEND_MESSAGE =
  'No web search provider is configured. Add a key in Settings > Named Secrets and bind it to a provider in the personality tool settings, or set EXA_API_KEY, TAVILY_API_KEY, or BRAVE_API_KEY.';

export interface CreateQuoraSearchToolOptions {
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

function formatHit(hit: SearchHit, index: number): string {
  const title = hit.title?.trim() || 'Untitled question';
  const snippet = hit.text?.trim().slice(0, SNIPPET_MAX_CHARS) ?? '';
  const lines = [`${index + 1}. **${title}**`, `   ${hit.url}`];
  if (snippet) lines.push(`   ${snippet}`);
  return lines.join('\n');
}

export function createQuoraSearchTool(opts: CreateQuoraSearchToolOptions = {}): Tool {
  const searxng = opts.searxngUrl ? createSearxngBackend(opts.searxngUrl) : null;

  // Same rung shape as web_search's own selectBackend
  // (extensions/tools-web/src/index.ts): rungs 1-3 (which key names the
  // binding) are tool-specific and stay a local `??` chain; rungs 4-6 live
  // in the shared `selectSearchBackend` (plan D4/D3a — this reads
  // web_search's binding, not a key of its own).
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
    name: 'quora_search',
    description:
      "Search Quora questions via the personality's web-search backend, constrained to quora.com. Search fidelity only — no answer counts, no vote counts, and no dates beyond what the backend returns. Shares the web_search credential binding rather than a key of its own.",
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
    // No settingsSchema (plan D3a) — deliberate. This tool has no tools.yaml
    // key of its own; it reads web_search's existing binding.
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
          description: `Number of questions to return (default ${DEFAULT_NUM_RESULTS}, max ${MAX_NUM_RESULTS})`,
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
      const siteQuery = `${query} ${QUORA_PROFILE.siteOperator}`;

      try {
        const hits =
          'searxng' in selected
            ? await selected.searxng.search(siteQuery, fetchCount, ctx)
            : await selected.backend.search(siteQuery, fetchCount, ctx, selected.secretRef);

        const filtered = filterAndDedupe(hits, QUORA_PROFILE).slice(0, numResults);
        if (filtered.length === 0) {
          return { ok: true, value: `No results found for: ${query}` };
        }

        const formatted = filtered.map((hit, i) => formatHit(hit, i)).join('\n\n');
        return { ok: true, value: `Quora questions for "${query}":\n\n${formatted}` };
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

export const quoraSearchTool = createQuoraSearchTool();
