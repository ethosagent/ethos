import type { LLMProvider, Tool, ToolContext, ToolResult } from '@ethosagent/types';
import { ALL_BACKENDS, type SearchBackend } from './search-backends';
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

function makeWebSearchTool(searchBackend?: 'exa' | 'tavily' | 'brave'): Tool {
  function selectBackend(): SearchBackend | null {
    if (searchBackend) {
      const pref = ALL_BACKENDS.find((b) => b.id === searchBackend);
      if (pref?.isAvailable()) return pref;
    }
    return ALL_BACKENDS.find((b) => b.isAvailable()) ?? null;
  }

  return {
    name: 'web_search',
    description:
      'Search the web for current information. Returns titles, URLs, and text snippets. Requires one of ETHOS_EXA_API_KEY, TAVILY_API_KEY, or BRAVE_API_KEY.',
    toolset: 'web',
    maxResultChars: 15_000,
    capabilities: {
      network: { allowedHosts: ['api.exa.ai', 'api.tavily.com', 'api.search.brave.com'] },
      secrets: ['providers/exa/apiKey', 'providers/tavily/apiKey', 'providers/brave/apiKey'],
    },
    outputIsUntrusted: true,
    isAvailable() {
      return ALL_BACKENDS.some((b) => b.isAvailable());
    },
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        num_results: {
          type: 'number',
          description: 'Number of results to return (default 5, max 10)',
        },
      },
      required: ['query'],
    },
    async execute(args, ctx): Promise<ToolResult> {
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

      const backend = selectBackend();
      if (!backend) {
        return {
          ok: false,
          error:
            'No web search backend available. Set ETHOS_EXA_API_KEY, TAVILY_API_KEY, or BRAVE_API_KEY.',
          code: 'not_available' as const,
        };
      }

      const numResults = Math.min(num_results ?? 5, 10);

      try {
        const hits = await backend.search(query, numResults, ctx);

        if (!hits.length) {
          return { ok: true, value: `No results found for: ${query}` };
        }

        const formatted = hits
          .map((r, i) => {
            const date = r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : '';
            const snippet = r.text?.trim().slice(0, 400) ?? '';
            return `${i + 1}. **${r.title ?? 'Untitled'}**${date}\n   ${r.url}\n   ${snippet}`;
          })
          .join('\n\n');

        return {
          ok: true,
          value: `Search results for "${query}" (via ${backend.id}):\n\n${formatted}`,
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
  return [makeWebSearchTool(opts.searchBackend), makeWebExtractTool(buildSummarizeBuilder(opts))];
}

export const webSearchTool = makeWebSearchTool();
export const webExtractTool = makeWebExtractTool();

export { checkSsrf } from './ssrf';
