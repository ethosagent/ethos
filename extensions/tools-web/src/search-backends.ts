import type { SecretRef, ToolContext } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Search backend contract — one per provider (Exa, Tavily, Brave)
// ---------------------------------------------------------------------------

export interface SearchHit {
  title?: string;
  url: string;
  text?: string;
  publishedDate?: string;
}

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
   */
  search(
    query: string,
    numResults: number,
    ctx: ToolContext,
    secretRef: SecretRef,
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
  async search(query, numResults, ctx, secretRef): Promise<SearchHit[]> {
    const apiKey = await ctx.secretsResolver?.get(secretRef);
    if (!apiKey) throw new Error('missing api key');
    const net = ctx.scopedFetch;
    if (!net) throw new Error('scopedFetch not configured');

    const response = await net.fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ query, numResults, contents: { text: { maxCharacters: 1500 } } }),
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
  async search(query, numResults, ctx, secretRef): Promise<SearchHit[]> {
    const apiKey = await ctx.secretsResolver?.get(secretRef);
    if (!apiKey) throw new Error('missing api key');
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
  async search(query, numResults, ctx, secretRef): Promise<SearchHit[]> {
    const apiKey = await ctx.secretsResolver?.get(secretRef);
    if (!apiKey) throw new Error('missing api key');
    const net = ctx.scopedFetch;
    if (!net) throw new Error('scopedFetch not configured');

    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
      query,
    )}&count=${numResults}`;
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
