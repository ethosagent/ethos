import type { LLMProvider, Tool, ToolContext, ToolResult } from '@ethosagent/types';
import { filterByMaxAge, MAX_AGE_GRAMMAR_HINT, maxAgePhrase, parseMaxAge } from './max-age';
import {
  createSearxngBackend,
  recencyLimitationNote,
  type SelectedBackend,
  selectSearchBackend,
  toIsoDate,
} from './search-backends';
import { checkSsrf } from './ssrf';
import { summarizeBySize } from './summarize';

// ---------------------------------------------------------------------------
// HTML → plain text (no external dep)
// ---------------------------------------------------------------------------

function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// web_search — dispatches across Exa / Tavily / Brave backends
// ---------------------------------------------------------------------------

/**
 * A resolved per-personality web_search binding: which provider, and which
 * named secret. `secret` is a NAME only (e.g. `exa-main`) — never a value —
 * that resolves to `providers/<provider>/<name>` in the vault. Absent `secret`
 * falls back to the provider's default-named secret (`providers/<id>/apiKey`).
 *
 * `recency` is the stored default for the `max_age` call argument — same
 * grammar, same parser (`parseMaxAge`), so the setting is not a second grammar.
 */
export interface WebSearchSetting {
  provider?: 'exa' | 'tavily' | 'brave';
  secret?: string;
  recency?: string;
}

interface WebSearchSelectionOptions {
  searchBackend?: 'exa' | 'tavily' | 'brave';
  /**
   * `web.searxng.url`. An extra, keyless RUNG rather than a bindable provider:
   * `web.search_backend` and the personality `tools.yaml` binding are both
   * typed to the three keyed providers, so SearXNG is reached by having no
   * keyed backend available — which is exactly what "an optional extra rung"
   * means in the config contract.
   */
  searxngUrl?: string;
  /** Personality-owned binding (source of truth), resolved by personalityId. */
  resolvePersonalitySetting?: (personalityId: string) => WebSearchSetting | undefined;
  /** Global FALLBACK map keyed by personalityId or `_default`. */
  toolSettings?: Record<string, { web_search?: WebSearchSetting } | undefined>;
}

function makeWebSearchTool(opts: WebSearchSelectionOptions = {}): Tool {
  const { searchBackend, resolvePersonalitySetting, toolSettings } = opts;
  const searxng = opts.searxngUrl ? createSearxngBackend(opts.searxngUrl) : null;

  // Rungs 1-3 are tool-specific (the `web_search` key in tools.yaml /
  // toolSettings) and stay a local `??` chain here, because this tool resolves
  // a whole SETTING (provider + secret) rather than a secret ref — unlike
  // `selectSecretRef` in extensions/tools-x-search/src/index.ts, which now
  // delegates to `resolveToolSecretRef` (packages/core/src/tool-secret-ref.ts)
  // and therefore falls through on a blank or malformed name. Rungs 4-6
  // (explicit provider → construction-time preference → first-available →
  // keyless SearXNG) are generic over any backend-dispatching tool and live
  // in the shared `selectSearchBackend` (search-backends.ts).
  function resolveSetting(ctx: ToolContext): WebSearchSetting | undefined {
    const pid = ctx.personalityId;
    return (
      (pid ? resolvePersonalitySetting?.(pid) : undefined) ??
      (pid ? toolSettings?.[pid]?.web_search : undefined) ??
      toolSettings?._default?.web_search
    );
  }

  function selectBackend(ctx: ToolContext): SelectedBackend | null {
    return selectSearchBackend({ bindings: [resolveSetting(ctx)], searchBackend, searxng });
  }

  return {
    name: 'web_search',
    description:
      "Search the web for current information. Returns titles, URLs, text snippets, and the publication date as ISO YYYY-MM-DD when the backend supplied one (omitted when it did not — a missing date is never guessed). Optionally restrict results to a recency window with max_age, a duration like 30d, 6m or 1y; omit it for no recency filter. On the Tavily backend the window matches a page's publish date OR its last-updated date, so a stale page edited yesterday can match a short window. Requires one of EXA_API_KEY, TAVILY_API_KEY, or BRAVE_API_KEY, or a configured SearXNG instance.",
    toolset: 'web',
    maxResultChars: 15_000,
    capabilities: {
      // The SearXNG host is operator-configured, so it joins the allowlist at
      // construction — the tool still cannot reach anything else.
      network: {
        allowedHosts: [
          'api.exa.ai',
          'api.tavily.com',
          'api.search.brave.com',
          ...(searxng ? [searxng.host] : []),
        ],
      },
      // Prefix grant over web_search's own provider namespaces. Any
      // personality binding is `providers/<provider>/<name>`, so it always
      // falls inside this static allowlist — no per-binding runtime grant.
      // Refs outside these namespaces (LLM keys, channel tokens) stay denied.
      secrets: ['providers/exa/*', 'providers/tavily/*', 'providers/brave/*'],
    },
    outputIsUntrusted: true,
    // Phase 2 — per-personality config contract. The web personality-settings
    // UI renders this into a provider dropdown + a secret picker; the resulting
    // binding is written to the personality's tools.yaml (custom) or the global
    // toolSettings fallback (built-in). Only the secret NAME is ever stored.
    settingsSchema: {
      fields: [
        {
          kind: 'enum',
          key: 'provider',
          label: 'Provider',
          options: [
            { value: 'exa', label: 'Exa' },
            { value: 'tavily', label: 'Tavily' },
            { value: 'brave', label: 'Brave' },
          ],
        },
        {
          kind: 'secret-binding',
          key: 'secret',
          label: 'API key',
          secretKind: 'web-search',
        },
        // The stored default for `max_age` (D8). Every value here is a valid
        // `max_age`, so one `parseMaxAge` covers both the call argument and the
        // binding — the setting is not a second grammar. The five options are a
        // deliberately CLOSED subset of the open `<number><d|w|m|y>` grammar:
        // `ToolSettingsField` has exactly two kinds, `enum` and
        // `secret-binding`, so there is no free-text control to render an
        // arbitrary duration into, and adding one would be a change to a
        // deliberately-two-kind contract in `packages/types` for a dropdown.
        // No "none" option and no `default`: like `provider` above, unset means
        // unset — the form's Select is `allowClear` and `ToolSettingsForm`
        // deletes an empty field, so clearing this restores "no recency
        // filter".
        {
          kind: 'enum',
          key: 'recency',
          label: 'Recency',
          options: [
            { value: '7d', label: 'Last 7 days' },
            { value: '30d', label: 'Last 30 days' },
            { value: '90d', label: 'Last 90 days' },
            { value: '6m', label: 'Last 6 months' },
            { value: '1y', label: 'Last year' },
          ],
        },
      ],
    },
    // web_search is always registered. A key can arrive from an env var OR from
    // the named-secrets vault via a personality/global binding — and the vault
    // is not reachable at filter time (isAvailable has no ToolContext/resolver).
    // Gating solely on env vars would filter the tool out for a user who
    // onboarded purely through Settings > Named Secrets. Instead the tool stays
    // available and `execute` surfaces a clear "no key configured" error when no
    // backend can resolve one.
    isAvailable() {
      return true;
    },
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        num_results: {
          type: 'number',
          description: 'Number of results to return (default 5, max 10)',
        },
        max_age: {
          type: 'string',
          description:
            'Only return results published within this window, as a duration: <number><d|w|m|y>, e.g. 30d, 2w, 6m, 1y. Omit for no recency filter.',
        },
      },
      required: ['query'],
    },
    async execute(args, ctx): Promise<ToolResult> {
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
        return {
          ok: false,
          error:
            'No web search provider is configured. Add a key in Settings > Named Secrets and bind it to a provider in the personality tool settings, or set EXA_API_KEY, TAVILY_API_KEY, or BRAVE_API_KEY.',
          code: 'not_available' as const,
        };
      }
      const numResults = Math.min(num_results ?? 5, 10);

      // Precedence: call argument → binding `recency` → unset. A binding value
      // that fails the grammar is IGNORED, not refused — asymmetric with the
      // call argument on purpose. A bad call argument is the caller's own
      // mistake, made in this request, and refusing it is how the caller learns
      // the grammar; a bad stored setting was made once, elsewhere, and
      // refusing it would break every search the personality ever runs.
      const maxAge = argMaxAge ?? parseMaxAge(resolveSetting(ctx)?.recency);

      const options = maxAge ? { maxAge } : undefined;

      try {
        const providerId = 'searxng' in selected ? selected.searxng.id : selected.backend.id;
        const hits =
          'searxng' in selected
            ? await selected.searxng.search(query, numResults, ctx, options)
            : await selected.backend.search(query, numResults, ctx, selected.secretRef, options);

        // The window is enforced HERE, not by the provider parameter — see
        // `filterByMaxAge`. Applied before the empty check so a window that
        // filters everything out reports the window rather than nothing.
        const filtered = maxAge ? filterByMaxAge(hits, maxAge) : hits;

        if (!filtered.length) {
          // The window is named because a model that has forgotten it set a
          // filter reads a bare "no results" as a fact about the web, and its
          // next move is to rephrase the query against the same constraint
          // rather than to widen the window.
          return {
            ok: true,
            value: maxAge
              ? `No results found for: ${query} in the ${maxAgePhrase(maxAge)} (via ${providerId})`
              : `No results found for: ${query}`,
          };
        }

        const formatted = filtered
          .map((r, i) => {
            const iso = toIsoDate(r.publishedDate);
            const date = iso ? ` (${iso})` : '';
            const snippet = r.text?.trim().slice(0, 400) ?? '';
            return `${i + 1}. **${r.title ?? 'Untitled'}**${date}\n   ${r.url}\n   ${snippet}`;
          })
          .join('\n\n');

        const window = maxAge ? ` — ${maxAgePhrase(maxAge)}` : '';
        const note = maxAge ? recencyLimitationNote(providerId, maxAge) : null;
        const header = `Search results for "${query}"${window} (via ${providerId}):`;

        return {
          ok: true,
          value: `${header}${note ? `\nNote: ${note}.` : ''}\n\n${formatted}`,
        };
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

// ---------------------------------------------------------------------------
// web_extract — fetch page content; size-tiered aux-model summarization
// ---------------------------------------------------------------------------

function makeWebExtractTool(
  buildSummarize?: (ctx: ToolContext) => ((chunk: string) => Promise<string>) | null,
): Tool {
  return {
    name: 'web_extract',
    description:
      'Fetch a URL and extract its text content. Use to read articles, documentation, or any web page.',
    toolset: 'web',
    maxResultChars: 20_000,
    capabilities: {
      // Tool fetches arbitrary user-supplied URLs; SSRF protection is enforced
      // by ScopedFetch → safeFetch, not by this allowlist. The personality-level
      // network policy provides the outer gate.
      network: { allowedHosts: ['*'] },
      secrets: ['providers/exa/apiKey'],
    },
    outputIsUntrusted: true,
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
      },
      required: ['url'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { url } = args as { url: string };

      if (!url) return { ok: false, error: 'url is required', code: 'input_invalid' };

      const ssrf = await checkSsrf(url);
      if (ssrf.blocked) return { ok: false, error: ssrf.reason, code: 'execution_failed' };

      const secrets = ctx.secretsResolver;
      const net = ctx.scopedFetch;
      if (!secrets || !net) {
        return {
          ok: false,
          error: 'Capability backends not configured',
          code: 'not_available' as const,
        };
      }

      try {
        const response = await net.fetch(url, {
          signal: ctx.abortSignal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Ethos/1.0; +https://github.com/ethos)',
            Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
          },
        });

        if (!response.ok) {
          return {
            ok: false,
            error: `HTTP ${response.status} ${response.statusText}`,
            code: 'execution_failed',
          };
        }

        const contentType = response.headers.get('content-type') ?? '';
        const body = await response.text();
        const text = contentType.includes('html') ? htmlToText(body) : body;
        const header = `[${url}]\n\n`;

        const summarize = buildSummarize?.(ctx) ?? null;
        if (!summarize) {
          return { ok: true, value: header + text };
        }
        const result = await summarizeBySize(text, summarize);
        if ('tooLarge' in result) {
          return {
            ok: false,
            error: 'Page too large to extract (>2,000,000 chars)',
            code: 'execution_failed',
          };
        }
        return { ok: true, value: header + result.value };
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateWebToolsOptions {
  searchBackend?: 'exa' | 'tavily' | 'brave';
  /** `web.searxng.url` — the keyless metasearch rung. Absent = not offered. */
  searxngUrl?: string;
  /**
   * Resolve the active personality's own `tools.yaml` web_search binding
   * (source of truth), keyed by personalityId. Wiring passes a lookup over
   * the personality registry.
   */
  resolvePersonalitySetting?: (personalityId: string) => WebSearchSetting | undefined;
  /** Global FALLBACK map keyed by personalityId or `_default`. */
  toolSettings?: Record<string, { web_search?: WebSearchSetting } | undefined>;
  auxModel?: string;
  resolveProvider?: (model: string) => LLMProvider | null;
}

function buildSummarizeBuilder(
  opts: CreateWebToolsOptions,
): ((ctx: ToolContext) => ((chunk: string) => Promise<string>) | null) | undefined {
  const auxModel = opts.auxModel;
  if (!auxModel) return undefined;
  const buildPrompt = (chunk: string) =>
    `Extract and preserve the key factual content of the following web page. Be comprehensive but remove navigation, ads, and boilerplate. Return clean prose/markdown.\n\n${chunk}`;
  const provider = opts.resolveProvider ? opts.resolveProvider(auxModel) : null;
  return (ctx: ToolContext) => {
    if (provider) {
      return async (chunk: string): Promise<string> => {
        const stream = provider.complete(
          [{ role: 'user', content: [{ type: 'text', text: buildPrompt(chunk) }] }],
          [],
          { modelOverride: auxModel, abortSignal: ctx.abortSignal },
        );
        let out = '';
        for await (const ev of stream) {
          if (ev.type === 'text_delta') out += ev.text;
        }
        return out;
      };
    }
    const llm = ctx.llm;
    if (llm) {
      return async (chunk: string): Promise<string> =>
        llm.complete(buildPrompt(chunk), { model: auxModel });
    }
    return null;
  };
}

export function createWebTools(opts: CreateWebToolsOptions = {}): Tool[] {
  return [
    makeWebSearchTool({
      ...(opts.searchBackend ? { searchBackend: opts.searchBackend } : {}),
      ...(opts.searxngUrl ? { searxngUrl: opts.searxngUrl } : {}),
      ...(opts.resolvePersonalitySetting
        ? { resolvePersonalitySetting: opts.resolvePersonalitySetting }
        : {}),
      ...(opts.toolSettings ? { toolSettings: opts.toolSettings } : {}),
    }),
    makeWebExtractTool(buildSummarizeBuilder(opts)),
  ];
}

export const webSearchTool = makeWebSearchTool();
export const webExtractTool = makeWebExtractTool();

// Re-exported for other extensions that dispatch across the same keyed
// backends (quora_search / linkedin_search in @ethosagent/tools-social-search,
// plan/phases/social-search-tools.md D3) rather than duplicating the Exa /
// Tavily / Brave adapters. Implementation lives in ./search-backends.ts.
export type { MaxAge, MaxAgeUnit } from './max-age';
export {
  filterByMaxAge,
  MAX_AGE_GRAMMAR_HINT,
  maxAgePhrase,
  maxAgeSince,
  parseMaxAge,
} from './max-age';
export type {
  KeylessSearchBackend,
  SearchBackend,
  SearchHit,
  SearchOptions,
  SearchProviderBinding,
  SelectBackendInput,
  SelectedBackend,
} from './search-backends';
export {
  ALL_BACKENDS,
  createSearxngBackend,
  recencyLimitationNote,
  searxngTimeRange,
  selectSearchBackend,
  toIsoDate,
} from './search-backends';
export { checkSsrf } from './ssrf';
