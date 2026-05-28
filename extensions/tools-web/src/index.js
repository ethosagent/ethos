// ---------------------------------------------------------------------------
// HTML → plain text (no external dep)
// ---------------------------------------------------------------------------
function htmlToText(html) {
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
// web_search — Exa API (ETHOS_EXA_API_KEY)
// ---------------------------------------------------------------------------
export const webSearchTool = {
  name: 'web_search',
  description:
    'Search the web for current information. Returns titles, URLs, and text snippets. Requires ETHOS_EXA_API_KEY environment variable.',
  toolset: 'web',
  maxResultChars: 15_000,
  capabilities: {
    network: { allowedHosts: ['api.exa.ai'] },
    secrets: ['providers/exa/apiKey'],
  },
  outputIsUntrusted: true,
  isAvailable() {
    return Boolean(process.env.ETHOS_EXA_API_KEY);
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
  async execute(args, ctx) {
    const { query, num_results } = args;
    if (!query) return { ok: false, error: 'query is required', code: 'input_invalid' };
    const secrets = ctx.secretsResolver;
    const net = ctx.scopedFetch;
    if (!secrets || !net) {
      return {
        ok: false,
        error: 'Capability backends not configured',
        code: 'not_available',
      };
    }
    const apiKey = await secrets.get('providers/exa/apiKey');
    const numResults = Math.min(num_results ?? 5, 10);
    try {
      const response = await net.fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({
          query,
          numResults,
          contents: { text: { maxCharacters: 1500 } },
        }),
        signal: ctx.abortSignal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return {
          ok: false,
          error: `Exa API error ${response.status}: ${body}`,
          code: 'execution_failed',
        };
      }
      const data = await response.json();
      if (!data.results?.length) {
        return { ok: true, value: `No results found for: ${query}` };
      }
      const formatted = data.results
        .map((r, i) => {
          const date = r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : '';
          const snippet = r.text?.trim().slice(0, 400) ?? '';
          return `${i + 1}. **${r.title ?? 'Untitled'}**${date}\n   ${r.url}\n   ${snippet}`;
        })
        .join('\n\n');
      return { ok: true, value: `Search results for "${query}":\n\n${formatted}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'execution_failed',
      };
    }
  },
};
// ---------------------------------------------------------------------------
// web_extract — fetch page content (no API key needed)
// ---------------------------------------------------------------------------
export const webExtractTool = {
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
  async execute(args, ctx) {
    const { url } = args;
    if (!url) return { ok: false, error: 'url is required', code: 'input_invalid' };
    const secrets = ctx.secretsResolver;
    const net = ctx.scopedFetch;
    if (!secrets || !net) {
      return {
        ok: false,
        error: 'Capability backends not configured',
        code: 'not_available',
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
      return { ok: true, value: header + text };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'execution_failed',
      };
    }
  },
};
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createWebTools() {
  return [webSearchTool, webExtractTool];
}
export { checkSsrf } from './ssrf';
