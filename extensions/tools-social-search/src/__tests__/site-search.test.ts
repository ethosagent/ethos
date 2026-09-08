import { MAX_AGE_GRAMMAR_HINT } from '@ethosagent/tools-web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLinkedInSearchTool } from '../site/linkedin';
import { createQuoraSearchTool } from '../site/quora';
import { createRedditWebSearchTool } from '../site/reddit';

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
  /** Brave's own published-date field, mapped to `SearchHit.publishedDate`. */
  page_age?: string;
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

// ---------------------------------------------------------------------------
// reddit_web_search — the credential-free rung under reddit_search. Same
// SiteProfile machinery as the two above; the interesting part is the post-id
// dedupe, which has to collapse every URL spelling of one post.
// ---------------------------------------------------------------------------

describe('reddit_web_search — path filtering', () => {
  it('never returns /user/, /search, or /wiki/ hits, and does return a /r/<sub>/comments/<id>/<slug> post', async () => {
    const rec = makeBraveFetch([
      {
        title: 'Why is the sky blue?',
        url: 'https://www.reddit.com/r/askscience/comments/abc123/why_is_the_sky_blue/',
      },
      { title: 'A user page', url: 'https://www.reddit.com/user/someone/' },
      { title: 'A search page', url: 'https://www.reddit.com/search/?q=sky' },
      { title: 'A wiki page', url: 'https://www.reddit.com/wiki/index/' },
    ]);
    const tool = createRedditWebSearchTool(BRAVE_BINDING);
    const result = await tool.execute({ query: 'sky' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toContain('/user/');
      expect(result.value).not.toContain('/search');
      expect(result.value).not.toContain('/wiki/');
      expect(result.value).toContain('/r/askscience/comments/abc123/');
    }
  });

  it('drops a subreddit listing page — a directory of conversations is not one', async () => {
    const rec = makeBraveFetch([
      { title: 'r/askscience', url: 'https://www.reddit.com/r/askscience/' },
      { title: 'Top of r/askscience', url: 'https://www.reddit.com/r/askscience/top/' },
      { title: 'Subreddit wiki', url: 'https://www.reddit.com/r/askscience/wiki/faq/' },
    ]);
    const tool = createRedditWebSearchTool(BRAVE_BINDING);
    const result = await tool.execute({ query: 'sky' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatch(/No results found/);
  });

  it('drops a look-alike host (reddit.com.evil.test) — registrable-host equality, not substring', async () => {
    const rec = makeBraveFetch([
      {
        title: 'Fake',
        url: 'https://reddit.com.evil.test/r/askscience/comments/abc123/why_is_the_sky_blue/',
      },
    ]);
    const tool = createRedditWebSearchTool(BRAVE_BINDING);
    const result = await tool.execute({ query: 'sky' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatch(/No results found/);
  });
});

describe('reddit_web_search — de-duplication', () => {
  it('collapses www/old hosts, a different slug, a comment permalink, and the bare /comments/<id> form into one entry', async () => {
    const rec = makeBraveFetch([
      {
        title: 'Why is the sky blue? : r/askscience',
        url: 'https://www.reddit.com/r/askscience/comments/abc123/why_is_the_sky_blue/',
      },
      {
        title: 'Why is the sky blue? - Reddit',
        url: 'https://old.reddit.com/r/askscience/comments/abc123/why_is_the_sky_blue/',
      },
      {
        title: 'Sky colour explained',
        url: 'https://www.reddit.com/r/askscience/comments/abc123/a_different_slug/',
      },
      {
        title: 'A comment on that post',
        url: 'https://www.reddit.com/r/askscience/comments/abc123/why_is_the_sky_blue/def456/',
      },
      { title: 'Canonical short form', url: 'https://www.reddit.com/comments/abc123' },
      {
        title: 'Uppercase id spelling',
        url: 'https://np.reddit.com/r/askscience/comments/ABC123/',
      },
    ]);
    const tool = createRedditWebSearchTool(BRAVE_BINDING);
    const result = await tool.execute({ query: 'sky' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const occurrences = result.value.match(/\d+\. \*\*/g) ?? [];
      expect(occurrences).toHaveLength(1);
      // First occurrence wins, and the "…: r/askscience" title decoration is
      // stripped because the subreddit is rendered from the URL instead.
      expect(result.value).toContain('1. **Why is the sky blue?** — r/askscience');
    }
  });

  it('keeps two genuinely different posts', async () => {
    const rec = makeBraveFetch([
      { title: 'First', url: 'https://www.reddit.com/r/askscience/comments/abc123/first/' },
      { title: 'Second', url: 'https://www.reddit.com/r/askscience/comments/xyz789/second/' },
    ]);
    const tool = createRedditWebSearchTool(BRAVE_BINDING);
    const result = await tool.execute({ query: 'sky' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.match(/\d+\. \*\*/g) ?? []).toHaveLength(2);
  });
});

describe('reddit_web_search — rendering', () => {
  it('renders index, title, subreddit, URL, and a snippet', async () => {
    const rec = makeBraveFetch([
      {
        title: 'Why is the sky blue?',
        url: 'https://www.reddit.com/r/askscience/comments/abc123/why_is_the_sky_blue/',
        description: 'Rayleigh scattering favours shorter wavelengths.',
      },
    ]);
    const tool = createRedditWebSearchTool(BRAVE_BINDING);
    const result = await tool.execute({ query: 'sky' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(
        'Reddit posts for "sky":\n\n' +
          '1. **Why is the sky blue?** — r/askscience\n' +
          '   https://www.reddit.com/r/askscience/comments/abc123/why_is_the_sky_blue/\n' +
          '   Rayleigh scattering favours shorter wavelengths.',
      );
    }
  });
});

describe('reddit_web_search — query and over-fetch', () => {
  it('appends the site: operator to the query', async () => {
    const rec = makeBraveFetch([]);
    const tool = createRedditWebSearchTool(BRAVE_BINDING);
    await tool.execute({ query: 'sky' }, ctxWith(rec.scopedFetch));
    const url = new URL(rec.calls[0] ?? '');
    expect(url.searchParams.get('q')).toBe('sky site:reddit.com');
  });

  it('over-fetches min(num_results * 3, 30) and trims to num_results', async () => {
    const hits: BraveHit[] = Array.from({ length: 30 }, (_, i) => ({
      title: `Post ${i}`,
      url: `https://www.reddit.com/r/test/comments/id${i}/slug/`,
    }));
    const rec = makeBraveFetch(hits);
    const tool = createRedditWebSearchTool(BRAVE_BINDING);

    const result = await tool.execute({ query: 'q', num_results: 4 }, ctxWith(rec.scopedFetch));
    const url = new URL(rec.calls[0] ?? '');
    expect(url.searchParams.get('count')).toBe('12'); // min(4*3, 30)
    expect(result.ok).toBe(true);
    if (result.ok) {
      const occurrences = result.value.match(/\d+\. \*\*Post/g) ?? [];
      expect(occurrences).toHaveLength(4);
    }
  });

  it('caps the over-fetch at 30 for a larger num_results', async () => {
    const rec = makeBraveFetch([]);
    const tool = createRedditWebSearchTool(BRAVE_BINDING);
    await tool.execute({ query: 'q', num_results: 10 }, ctxWith(rec.scopedFetch));
    const url = new URL(rec.calls[0] ?? '');
    expect(url.searchParams.get('count')).toBe('30'); // min(10*3, 30)
  });
});

describe('reddit_web_search — no backend configured', () => {
  it("returns not_available with web_search's own message when no backend and no SearXNG resolve", async () => {
    const rec = makeBraveFetch([]);
    const tool = createRedditWebSearchTool();
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
// Published dates — the defect these close: `SearchHit.publishedDate` was
// populated by every backend and rendered by none of the three site tools, so
// every harvested item reached a consumer dateless. A dateless item never ages
// out of a retention window and scores as "posted seconds ago".
//
// The other half of the contract is that a MISSING date stays visibly missing.
// A consumer treats a present date as trustworthy, so a default, a guess, or
// today's date would be worse than the original bug.
// ---------------------------------------------------------------------------

/** `[tool name, factory, a hit URL, a SECOND hit URL that survives the profile's
 *  dedupe alongside the first]`. The second is spelled out rather than derived
 *  from the first because each profile dedupes on a different part of the URL —
 *  Reddit collapses on the post id, so two `…/comments/abc123/…` spellings are
 *  one entry however much the rest differs. */
const DATE_TOOLS = [
  [
    'quora_search',
    createQuoraSearchTool,
    'https://www.quora.com/Why-is-the-sky-blue',
    'https://www.quora.com/Why-is-grass-green',
  ],
  [
    'linkedin_search',
    createLinkedInSearchTool,
    'https://www.linkedin.com/pulse/some-article',
    'https://www.linkedin.com/pulse/another-article',
  ],
  [
    'reddit_web_search',
    createRedditWebSearchTool,
    'https://www.reddit.com/r/askscience/comments/abc123/why_is_the_sky_blue/',
    'https://www.reddit.com/r/askscience/comments/xyz789/why_is_grass_green/',
  ],
] as const;

describe.each(DATE_TOOLS)('%s — published date rendering', (_name, create, url, otherUrl) => {
  it('renders the backend’s date as ISO YYYY-MM-DD at the end of the heading line', async () => {
    const rec = makeBraveFetch([{ title: 'A thing', url, page_age: '2026-08-14T00:00:00' }]);
    const result = await create(BRAVE_BINDING).execute({ query: 'sky' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const heading = result.value.split('\n').find((l) => l.startsWith('1. **'));
      expect(heading).toMatch(/ \(2026-08-14\)$/);
    }
  });

  it('normalizes a non-ISO date rather than slicing it into nonsense', async () => {
    const rec = makeBraveFetch([
      { title: 'A thing', url, page_age: 'Mon, 09 Feb 2026 00:00:00 GMT' },
    ]);
    const result = await create(BRAVE_BINDING).execute({ query: 'sky' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('(2026-02-09)');
  });

  it('renders NO date field and fabricates nothing when the backend supplied none', async () => {
    const rec = makeBraveFetch([{ title: 'A thing', url, description: 'a snippet' }]);
    const result = await create(BRAVE_BINDING).execute({ query: 'sky' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // No parenthesised date anywhere, and specifically not today's.
      expect(result.value).not.toMatch(/\(\d{4}-\d{2}-\d{2}\)/);
      expect(result.value).not.toContain(new Date().toISOString().slice(0, 10));
      expect(result.value.toLowerCase()).not.toContain('unknown');
    }
  });

  it('renders a date for the hits that have one and none for the hits that do not', async () => {
    const rec = makeBraveFetch([
      { title: 'Dated', url, page_age: '2026-01-02' },
      { title: 'Undated', url: otherUrl },
    ]);
    const result = await create(BRAVE_BINDING).execute({ query: 'sky' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const lines = result.value.split('\n');
      expect(lines.find((l) => l.includes('**Dated**'))).toMatch(/ \(2026-01-02\)$/);
      expect(lines.find((l) => l.includes('**Undated**'))).not.toMatch(/\(\d{4}-\d{2}-\d{2}\)/);
    }
  });
});

describe('reddit_web_search — exact rendered output with a date', () => {
  it('appends the date after the subreddit, at the end of the heading line', async () => {
    const rec = makeBraveFetch([
      {
        title: 'Why is the sky blue?',
        url: 'https://www.reddit.com/r/askscience/comments/abc123/why_is_the_sky_blue/',
        description: 'Rayleigh scattering favours shorter wavelengths.',
        page_age: '2026-08-14T09:12:00',
      },
    ]);
    const tool = createRedditWebSearchTool(BRAVE_BINDING);
    const result = await tool.execute({ query: 'sky' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(
        'Reddit posts for "sky":\n\n' +
          '1. **Why is the sky blue?** — r/askscience (2026-08-14)\n' +
          '   https://www.reddit.com/r/askscience/comments/abc123/why_is_the_sky_blue/\n' +
          '   Rayleigh scattering favours shorter wavelengths.',
      );
    }
  });
});

describe('linkedin_search — exact rendered output with a date', () => {
  it('appends the date after the author, at the end of the heading line', async () => {
    const rec = makeBraveFetch([
      {
        title: 'Jane Doe on LinkedIn: A post about AI',
        url: 'https://www.linkedin.com/pulse/some-article-title-jane-doe',
        description: 'A post about AI',
        page_age: '2026-08-14',
      },
    ]);
    const tool = createLinkedInSearchTool(BRAVE_BINDING);
    const result = await tool.execute({ query: 'ai' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(
        'LinkedIn posts for "ai":\n\n' +
          '1. **A post about AI** — Jane Doe (2026-08-14)\n' +
          '   https://www.linkedin.com/pulse/some-article-title-jane-doe',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// max_age — the recency duration grammar (extensions/tools-web/src/max-age.ts),
// plumbed from the tool argument down to the selected backend's own native
// parameter AND enforced locally by `filterByMaxAge`. The provider parameter is
// only the request; the local filter is what makes the window true, which is
// why the drop/keep and filter-before-slice cases below matter as much as the
// query-string one.
//
// Brave is the deterministic backend these tests bind, so the outbound
// assertion is on `freshness` in the query string; the full four-backend
// mapping is pinned in extensions/tools-web/src/__tests__/tools-web.test.ts.
// ---------------------------------------------------------------------------

/** `[tool name, factory, query, rendered heading, a URL factory whose values
 *  all survive that tool's own SiteProfile filter AND its dedupe]`. */
const RECENCY_TOOLS = [
  [
    'quora_search',
    createQuoraSearchTool,
    'sky',
    'Quora questions',
    (i: number) => `https://www.quora.com/Question-${i}`,
  ],
  [
    'linkedin_search',
    createLinkedInSearchTool,
    'ai',
    'LinkedIn posts',
    (i: number) => `https://www.linkedin.com/pulse/post-${i}`,
  ],
  [
    'reddit_web_search',
    createRedditWebSearchTool,
    'sky',
    'Reddit posts',
    (i: number) => `https://www.reddit.com/r/test/comments/id${i}/slug/`,
  ],
] as const;

// A fixed clock, because both the outbound `freshness` range and the local
// filter's cutoff are functions of `Date.now()`; only `Date` is faked, so the
// fetch stubs' promises still resolve normally.
const NOW = new Date('2026-09-08T12:00:00.000Z');
const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const daysBefore = (n: number): string => ymd(NOW.getTime() - n * 86_400_000);

describe.each(RECENCY_TOOLS)('%s — max_age', (_name, create, query, heading, url) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reaches the backend as its own native recency parameter (Brave's dated range)", async () => {
    const rec = makeBraveFetch([]);
    await create(BRAVE_BINDING).execute({ query, max_age: '30d' }, ctxWith(rec.scopedFetch));
    expect(new URL(rec.calls[0] ?? '').searchParams.get('freshness')).toBe(
      `${daysBefore(30)}to${daysBefore(0)}`,
    );
  });

  it('sends no recency parameter at all when max_age is omitted', async () => {
    const rec = makeBraveFetch([]);
    await create(BRAVE_BINDING).execute({ query }, ctxWith(rec.scopedFetch));
    expect(new URL(rec.calls[0] ?? '').searchParams.has('freshness')).toBe(false);
  });

  it('drops a dated hit outside the window and KEEPS an undated one', async () => {
    const rec = makeBraveFetch([
      { title: 'Stale', url: url(0), page_age: daysBefore(400) },
      { title: 'Undated', url: url(1) },
      { title: 'Fresh', url: url(2), page_age: daysBefore(3) },
    ]);
    const result = await create(BRAVE_BINDING).execute(
      { query, max_age: '30d' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toContain('Stale');
      // An undated hit is neither filtered nor claimed to be in-window — the
      // data cannot support dropping it (see `filterByMaxAge`).
      expect(result.value).toContain('Undated');
      expect(result.value).toContain('Fresh');
    }
  });

  it('filters BEFORE the final slice, so in-window hits still fill num_results', async () => {
    // The out-of-window hits come first in the over-fetched list. If the window
    // filter ran after `.slice(0, num_results)` these two would eat both slots
    // and the caller would get nothing.
    const rec = makeBraveFetch([
      { title: 'Stale A', url: url(0), page_age: daysBefore(400) },
      { title: 'Stale B', url: url(1), page_age: daysBefore(401) },
      { title: 'Fresh C', url: url(2), page_age: daysBefore(3) },
      { title: 'Fresh D', url: url(3), page_age: daysBefore(4) },
    ]);
    const result = await create(BRAVE_BINDING).execute(
      { query, num_results: 2, max_age: '30d' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.match(/\d+\. \*\*/g) ?? []).toHaveLength(2);
      expect(result.value).toContain('Fresh C');
      expect(result.value).toContain('Fresh D');
      expect(result.value).not.toContain('Stale');
    }
  });

  it('names the window in the header when filtering', async () => {
    // A hit is required: an empty result set short-circuits before the header.
    const rec = makeBraveFetch([{ title: 'A thing', url: url(0) }]);
    const result = await create(BRAVE_BINDING).execute(
      { query, max_age: '30d' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain(`${heading} for "${query}" — last 30 days:`);
  });

  it('names the window in the empty-result line when nothing survives it', async () => {
    const rec = makeBraveFetch([{ title: 'Stale', url: url(0), page_age: daysBefore(400) }]);
    const result = await create(BRAVE_BINDING).execute(
      { query, max_age: '30d' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    // A bare "no results" would read as a fact about the web, and the model's
    // next move would be to rephrase rather than widen.
    if (result.ok) {
      expect(result.value).toBe(`No results found for: ${query} in the last 30 days (via brave)`);
    }
  });

  it('refuses an unparseable window instead of silently searching unfiltered', async () => {
    const rec = makeBraveFetch([]);
    const result = await create(BRAVE_BINDING).execute(
      { query, max_age: '30x' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('input_invalid');
      // The shared hint, so a caller cannot learn the grammar from one tool
      // and be refused in different words by another.
      expect(result.error).toContain(MAX_AGE_GRAMMAR_HINT);
    }
    expect(rec.calls).toHaveLength(0);
  });

  // The stored default. These three tools have no tools.yaml key of their own —
  // they read `web_search`'s binding whole (plan D3a), so its `recency` is
  // their `max_age` default too, down the same
  // `tools.yaml → toolSettings[pid] → toolSettings._default` chain the
  // provider/secret already ride.
  const boundRecency = (recency: string) => ({
    resolvePersonalitySetting: () => ({ provider: 'brave' as const, recency }),
  });

  it("applies the binding's recency when max_age is absent", async () => {
    const rec = makeBraveFetch([{ title: 'A thing', url: url(0) }]);
    const result = await create(boundRecency('30d')).execute({ query }, ctxWith(rec.scopedFetch));
    expect(new URL(rec.calls[0] ?? '').searchParams.get('freshness')).toBe(
      `${daysBefore(30)}to${daysBefore(0)}`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain(`${heading} for "${query}" — last 30 days:`);
  });

  it("lets an explicit max_age override the binding's recency", async () => {
    const rec = makeBraveFetch([{ title: 'A thing', url: url(0) }]);
    const result = await create(boundRecency('1y')).execute(
      { query, max_age: '7d' },
      ctxWith(rec.scopedFetch),
    );
    expect(new URL(rec.calls[0] ?? '').searchParams.get('freshness')).toBe(
      `${daysBefore(7)}to${daysBefore(0)}`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain(`${heading} for "${query}" — last 7 days:`);
  });

  it('IGNORES an invalid stored recency and searches unfiltered, rather than refusing', async () => {
    // Asymmetric with the call argument on purpose: a bad stored setting was
    // made once, elsewhere, and refusing it would break every search the
    // personality ever runs.
    const rec = makeBraveFetch([{ title: 'A thing', url: url(0) }]);
    const result = await create(boundRecency('fortnight')).execute(
      { query },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    expect(new URL(rec.calls[0] ?? '').searchParams.has('freshness')).toBe(false);
    if (result.ok) expect(result.value).toContain(`${heading} for "${query}":`);
  });
});

describe.each(RECENCY_TOOLS)('%s — SearXNG bucket disclosure', (_name, create, query, _h, url) => {
  it('widens a 7-day window to the month bucket and says so in the rendered output', async () => {
    const calls: string[] = [];
    const scopedFetch = {
      fetch: async (u: string | URL): Promise<Response> => {
        calls.push(typeof u === 'string' ? u : u.toString());
        return new Response(JSON.stringify({ results: [{ title: 'A thing', url: url(0) }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    // No provider binding and no env keys (cleared in beforeEach) → the
    // keyless SearXNG rung is the only one left.
    const tool = create({ searxngUrl: 'https://searx.internal' });
    const result = await tool.execute({ query, max_age: '7d' }, ctxWith(scopedFetch));
    expect(new URL(calls[0] ?? '').searchParams.get('time_range')).toBe('month');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('only offers day/month/year windows');
      expect(result.value).toContain("requested upstream as 'month' and narrowed here");
    }
  });

  it('adds no note for a window it CAN express exactly', async () => {
    const scopedFetch = {
      fetch: async (): Promise<Response> =>
        new Response(JSON.stringify({ results: [{ title: 'A thing', url: url(0) }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    };
    const tool = create({ searxngUrl: 'https://searx.internal' });
    // 31d is the `month` bucket's own width, so nothing was approximated.
    const result = await tool.execute({ query, max_age: '31d' }, ctxWith(scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).not.toContain('Note:');
  });
});
