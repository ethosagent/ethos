import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLinkedInSearchTool } from '../site/linkedin';
import { createQuoraSearchTool } from '../site/quora';

// ---------------------------------------------------------------------------
// Fixtures — mirrors youtube-search.test.ts's mockSecrets/mockFetch/ctx
// conventions (plain-object ScopedSecretsResolver + ScopedFetch stubs, a
// recording fetch, never a live network call). Both tools are constructed
// with `resolvePersonalitySetting: () => ({ provider: 'brave' })` so
// `selectSearchBackend` picks a deterministic backend (rung 4 — an explicit
// provider binding — bypasses the env-var `isAvailable()` checks that rungs
// 5-6 depend on) and the Brave GET request shape (query string, not a JSON
// body) makes URL assertions simple.
// ---------------------------------------------------------------------------

const mockSecrets = { get: async (_ref: string) => 'test-api-key' };

type ScopedFetchLike = {
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
};

const ctx = {
  sessionId: 'test',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 80_000,
  secretsResolver: mockSecrets,
  // A truthy personalityId so `resolvePersonalitySetting` (rung 1 of the
  // binding lookup, gated on `ctx.personalityId` in both tools) actually
  // fires — see selectBackend in ../site/quora.ts and ../site/linkedin.ts.
  personalityId: 'test-personality',
};

function ctxWith(scopedFetch: ScopedFetchLike) {
  return { ...ctx, scopedFetch };
}

const BRAVE_BINDING = { resolvePersonalitySetting: () => ({ provider: 'brave' as const }) };

interface BraveHit {
  title?: string;
  url: string;
  description?: string;
}

/** Brave's response shape (`{ web: { results: [...] } }`), queued once. */
function makeBraveFetch(hits: BraveHit[]) {
  const calls: string[] = [];
  const fetch = async (url: string | URL): Promise<Response> => {
    calls.push(typeof url === 'string' ? url : url.toString());
    return new Response(JSON.stringify({ web: { results: hits } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { scopedFetch: { fetch }, calls };
}

const SEARCH_ENV_KEYS = ['EXA_API_KEY', 'TAVILY_API_KEY', 'BRAVE_API_KEY'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of SEARCH_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of SEARCH_ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---------------------------------------------------------------------------
// quora_search
// ---------------------------------------------------------------------------

describe('quora_search — path filtering', () => {
  it('never returns a /profile/ or /topic/ URL', async () => {
    const rec = makeBraveFetch([
      { title: 'A question', url: 'https://www.quora.com/Why-is-the-sky-blue' },
      { title: 'A profile', url: 'https://www.quora.com/profile/John-Doe' },
      { title: 'A topic', url: 'https://www.quora.com/topic/Physics' },
    ]);
    const tool = createQuoraSearchTool(BRAVE_BINDING);
    const result = await tool.execute({ query: 'sky' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toContain('/profile/');
      expect(result.value).not.toContain('/topic/');
      expect(result.value).toContain('Why-is-the-sky-blue');
    }
  });

  it('drops a look-alike host (quora.com.evil.test) — registrable-host equality, not substring', async () => {
    const rec = makeBraveFetch([
      { title: 'Fake', url: 'https://quora.com.evil.test/Why-is-the-sky-blue' },
    ]);
    const tool = createQuoraSearchTool(BRAVE_BINDING);
    const result = await tool.execute({ query: 'sky' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatch(/No results found/);
  });
});

describe('quora_search — de-duplication', () => {
  it('collapses the plain slug, its /answer/<author> form, and its /unanswered/ form into one entry', async () => {
    const rec = makeBraveFetch([
      { title: 'Why is the sky blue?', url: 'https://www.quora.com/Why-is-the-sky-blue' },
      {
        title: "John's answer",
        url: 'https://www.quora.com/Why-is-the-sky-blue/answer/John-Doe',
      },
      {
        title: 'Unanswered form',
        url: 'https://www.quora.com/unanswered/Why-is-the-sky-blue',
      },
    ]);
    const tool = createQuoraSearchTool(BRAVE_BINDING);
    const result = await tool.execute({ query: 'sky' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const occurrences = result.value.match(/Why-is-the-sky-blue/g) ?? [];
      expect(occurrences).toHaveLength(1);
    }
  });
});

describe('quora_search — query and over-fetch', () => {
  it('appends the site: operator to the query', async () => {
    const rec = makeBraveFetch([]);
    const tool = createQuoraSearchTool(BRAVE_BINDING);
    await tool.execute({ query: 'sky' }, ctxWith(rec.scopedFetch));
    const url = new URL(rec.calls[0] ?? '');
    expect(url.searchParams.get('q')).toBe('sky site:quora.com');
  });

  it('over-fetches min(num_results * 3, 30) and trims to num_results', async () => {
    const hits: BraveHit[] = Array.from({ length: 30 }, (_, i) => ({
      title: `Question ${i}`,
      url: `https://www.quora.com/Question-${i}`,
    }));
    const rec = makeBraveFetch(hits);
    const tool = createQuoraSearchTool(BRAVE_BINDING);

    const result = await tool.execute({ query: 'q', num_results: 5 }, ctxWith(rec.scopedFetch));
    const url = new URL(rec.calls[0] ?? '');
    expect(url.searchParams.get('count')).toBe('15'); // min(5*3, 30)
    expect(result.ok).toBe(true);
    if (result.ok) {
      const occurrences = result.value.match(/\d+\. \*\*Question/g) ?? [];
      expect(occurrences).toHaveLength(5);
    }
  });

  it('caps the over-fetch at 30 for a larger num_results', async () => {
    const rec = makeBraveFetch([]);
    const tool = createQuoraSearchTool(BRAVE_BINDING);
    await tool.execute({ query: 'q', num_results: 10 }, ctxWith(rec.scopedFetch));
    const url = new URL(rec.calls[0] ?? '');
    expect(url.searchParams.get('count')).toBe('30'); // min(10*3, 30)
  });
});

describe('quora_search — no backend configured', () => {
  it("returns not_available with web_search's own message when no backend and no SearXNG resolve", async () => {
    const rec = makeBraveFetch([]);
    const tool = createQuoraSearchTool(); // no bindings, no env keys, no searxng
    const result = await tool.execute({ query: 'sky' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toMatch(/No web search provider is configured/);
    }
    expect(rec.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// linkedin_search
// ---------------------------------------------------------------------------

describe('linkedin_search — path filtering', () => {
  it('never returns /in/, /company/, /school/, or /jobs/, and does return /posts/ and /pulse/', async () => {
    const rec = makeBraveFetch([
      {
        title: 'Jane Doe on LinkedIn: A post about AI',
        url: 'https://www.linkedin.com/posts/janedoe_a-post-about-ai-activity-1111111111111111111-AbCd',
      },
      { title: 'An article', url: 'https://www.linkedin.com/pulse/some-article-title-jane-doe' },
      { title: 'A profile', url: 'https://www.linkedin.com/in/janedoe' },
      { title: 'A company', url: 'https://www.linkedin.com/company/acme' },
      { title: 'A school', url: 'https://www.linkedin.com/school/acme-university' },
      { title: 'A job', url: 'https://www.linkedin.com/jobs/view/12345' },
    ]);
    const tool = createLinkedInSearchTool(BRAVE_BINDING);
    const result = await tool.execute({ query: 'ai' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toContain('/in/janedoe');
      expect(result.value).not.toContain('/company/');
      expect(result.value).not.toContain('/school/');
      expect(result.value).not.toContain('/jobs/');
      expect(result.value).toContain('/posts/');
      expect(result.value).toContain('/pulse/');
    }
  });
});

describe('linkedin_search — de-duplication', () => {
  it('collapses two /posts/ URLs sharing an activity-<id>', async () => {
    const rec = makeBraveFetch([
      {
        title: 'Jane Doe on LinkedIn: First slug text',
        url: 'https://www.linkedin.com/posts/janedoe_first-slug-text-activity-2222222222222222222-AbCd',
      },
      {
        title: 'Jane Doe on LinkedIn: Different slug text',
        url: 'https://www.linkedin.com/posts/janedoe_different-slug-text-activity-2222222222222222222-XyZa',
      },
    ]);
    const tool = createLinkedInSearchTool(BRAVE_BINDING);
    const result = await tool.execute({ query: 'ai' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const occurrences = result.value.match(/\d+\. \*\*/g) ?? [];
      expect(occurrences).toHaveLength(1);
    }
  });
});

describe('linkedin_search — query and over-fetch', () => {
  it('appends the site: operator to the query', async () => {
    const rec = makeBraveFetch([]);
    const tool = createLinkedInSearchTool(BRAVE_BINDING);
    await tool.execute({ query: 'ai' }, ctxWith(rec.scopedFetch));
    const url = new URL(rec.calls[0] ?? '');
    expect(url.searchParams.get('q')).toBe('ai site:linkedin.com');
  });

  it('over-fetches min(num_results * 3, 30) and trims to num_results', async () => {
    const hits: BraveHit[] = Array.from({ length: 30 }, (_, i) => ({
      title: `Post ${i}`,
      url: `https://www.linkedin.com/pulse/post-${i}`,
    }));
    const rec = makeBraveFetch(hits);
    const tool = createLinkedInSearchTool(BRAVE_BINDING);

    const result = await tool.execute({ query: 'q', num_results: 3 }, ctxWith(rec.scopedFetch));
    const url = new URL(rec.calls[0] ?? '');
    expect(url.searchParams.get('count')).toBe('9'); // min(3*3, 30)
    expect(result.ok).toBe(true);
    if (result.ok) {
      const occurrences = result.value.match(/\d+\. \*\*Post/g) ?? [];
      expect(occurrences).toHaveLength(3);
    }
  });
});

describe('linkedin_search — no backend configured', () => {
  it("returns not_available with web_search's own message when no backend and no SearXNG resolve", async () => {
    const rec = makeBraveFetch([]);
    const tool = createLinkedInSearchTool();
    const result = await tool.execute({ query: 'ai' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toMatch(/No web search provider is configured/);
    }
    expect(rec.calls).toHaveLength(0);
  });
});
