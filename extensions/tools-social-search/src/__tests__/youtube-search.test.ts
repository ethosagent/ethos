import { afterEach, describe, expect, it, vi } from 'vitest';
import { createYouTubeSearchTool, youtubeSearchTool } from '../index';

// ---------------------------------------------------------------------------
// Fixtures — mirrors extensions/tools-x-search/src/__tests__/x-search.test.ts's
// mockSecrets/mockFetch/ctx conventions (plain-object ScopedSecretsResolver +
// ScopedFetch stubs, a recording fetch, never a live network call).
// ---------------------------------------------------------------------------

const mockSecrets = { get: async (_ref: string) => 'test-api-key' };

type ScopedFetchLike = {
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
};

const mockFetch: ScopedFetchLike = {
  fetch: async () => new Response('{"items":[]}', { status: 200 }),
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
  scopedFetch: mockFetch,
};

const ctxWithoutCapabilities = {
  sessionId: 'test',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 80_000,
};

function ctxWith(scopedFetch: ScopedFetchLike, secrets = mockSecrets) {
  return { ...ctx, scopedFetch, secretsResolver: secrets };
}

/** A queue-based fetch stub: each call pops the next queued response, in order. */
function makeQueueFetch(responses: Array<{ body: unknown; status?: number }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: typeof url === 'string' ? url : url.toString(), init });
    const entry = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(entry.body), {
      status: entry.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { scopedFetch: { fetch }, calls };
}

const SEARCH_ITEM = {
  id: { videoId: 'vid00000001' },
  snippet: {
    title: 'A great video',
    description: 'A description of the video that is reasonably long.',
    channelTitle: 'Some Channel',
    publishedAt: '2026-01-01T00:00:00Z',
  },
};

const VIDEO_STATS = {
  items: [
    {
      id: 'vid00000001',
      statistics: { viewCount: '1000', likeCount: '50', commentCount: '5' },
    },
  ],
};

// ---------------------------------------------------------------------------

describe('youtube_search — availability', () => {
  it('isAvailable always returns true, regardless of key presence', () => {
    expect(youtubeSearchTool.isAvailable?.()).toBe(true);
  });

  it('returns not_available when capability backends are missing', async () => {
    const result = await youtubeSearchTool.execute({ query: 'test' }, ctxWithoutCapabilities);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });
});

describe('youtube_search — input validation', () => {
  it('returns input_invalid if query is missing', async () => {
    const result = await youtubeSearchTool.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });
});

describe('youtube_search — no key configured', () => {
  it('produces a clear error naming Named Secrets and YOUTUBE_API_KEY, not a raw fetch failure', async () => {
    const rec = makeQueueFetch([{ body: {} }]);
    const noKeySecrets = { get: async (_ref: string) => '' };
    const result = await youtubeSearchTool.execute(
      { query: 'q' },
      ctxWith(rec.scopedFetch, noKeySecrets),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toMatch(/Named Secrets/i);
      expect(result.error).toMatch(/YOUTUBE_API_KEY/);
    }
    expect(rec.calls).toHaveLength(0);
  });
});

describe('youtube_search — request shape', () => {
  it('hits googleapis.com/youtube/v3/search with part=snippet&type=video and the key on the query string', async () => {
    const rec = makeQueueFetch([{ body: { items: [SEARCH_ITEM] } }, { body: VIDEO_STATS }]);
    await youtubeSearchTool.execute({ query: 'cats' }, ctxWith(rec.scopedFetch));
    expect(rec.calls).toHaveLength(2);
    const first = rec.calls[0]?.url ?? '';
    expect(first).toContain('https://www.googleapis.com/youtube/v3/search?');
    expect(first).toContain('part=snippet');
    expect(first).toContain('type=video');
    expect(first).toContain('q=cats');
    expect(first).toContain('key=test-api-key');
  });

  it('clamps max_results at the cap (25)', async () => {
    const rec = makeQueueFetch([{ body: { items: [SEARCH_ITEM] } }, { body: VIDEO_STATS }]);
    await youtubeSearchTool.execute({ query: 'cats', max_results: 999 }, ctxWith(rec.scopedFetch));
    expect(rec.calls[0]?.url).toContain('maxResults=25');
  });

  it('passes order through', async () => {
    const rec = makeQueueFetch([{ body: { items: [SEARCH_ITEM] } }, { body: VIDEO_STATS }]);
    await youtubeSearchTool.execute({ query: 'cats', order: 'date' }, ctxWith(rec.scopedFetch));
    expect(rec.calls[0]?.url).toContain('order=date');
  });

  it('includes publishedAfter only when supplied', async () => {
    const withDate = makeQueueFetch([{ body: { items: [SEARCH_ITEM] } }, { body: VIDEO_STATS }]);
    await youtubeSearchTool.execute(
      { query: 'cats', published_after: '2026-01-01T00:00:00Z' },
      ctxWith(withDate.scopedFetch),
    );
    expect(withDate.calls[0]?.url).toContain('publishedAfter=2026-01-01');

    const withoutDate = makeQueueFetch([{ body: { items: [SEARCH_ITEM] } }, { body: VIDEO_STATS }]);
    await youtubeSearchTool.execute({ query: 'cats' }, ctxWith(withoutDate.scopedFetch));
    expect(withoutDate.calls[0]?.url).not.toContain('publishedAfter');
  });
});

describe('youtube_search — two-call flow', () => {
  it('issues exactly two fetches: search.list then videos.list over the returned ids', async () => {
    const rec = makeQueueFetch([{ body: { items: [SEARCH_ITEM] } }, { body: VIDEO_STATS }]);
    await youtubeSearchTool.execute({ query: 'cats' }, ctxWith(rec.scopedFetch));
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[1]?.url).toContain('https://www.googleapis.com/youtube/v3/videos?');
    expect(rec.calls[1]?.url).toContain('part=statistics');
    expect(rec.calls[1]?.url).toContain('id=vid00000001');
  });

  it('renders view/like/comment counts from the statistics call', async () => {
    const rec = makeQueueFetch([{ body: { items: [SEARCH_ITEM] } }, { body: VIDEO_STATS }]);
    const result = await youtubeSearchTool.execute({ query: 'cats' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatch(/1000 views/);
      expect(result.value).toMatch(/50 likes/);
      expect(result.value).toMatch(/5 comments/);
    }
  });

  it('a failing statistics call still yields the hits, without counts', async () => {
    const rec = makeQueueFetch([
      { body: { items: [SEARCH_ITEM] } },
      { body: { error: 'boom' }, status: 500 },
    ]);
    const result = await youtubeSearchTool.execute({ query: 'cats' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('A great video');
      expect(result.value).not.toMatch(/views/);
      expect(result.value).toMatch(/unavailable/i);
    }
  });

  it('reports "No results found" as ok:true for an empty result set', async () => {
    const rec = makeQueueFetch([{ body: { items: [] } }]);
    const result = await youtubeSearchTool.execute(
      { query: 'zzznoresults' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatch(/No results found/);
  });

  it('states 101 units in the footer', async () => {
    const rec = makeQueueFetch([{ body: { items: [SEARCH_ITEM] } }, { body: VIDEO_STATS }]);
    const result = await youtubeSearchTool.execute({ query: 'cats' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('101 units');
  });
});

describe('youtube_search — error mapping', () => {
  it('maps 403 keyInvalid to not_available with the no-key message', async () => {
    const rec = makeQueueFetch([
      { body: { error: { errors: [{ reason: 'keyInvalid' }] } }, status: 403 },
    ]);
    const result = await youtubeSearchTool.execute({ query: 'cats' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toMatch(/Google API key/i);
    }
  });

  it('maps 401 to not_available', async () => {
    const rec = makeQueueFetch([{ body: {}, status: 401 }]);
    const result = await youtubeSearchTool.execute({ query: 'cats' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });

  it('maps 403 quotaExceeded to execution_failed naming the 10,000-unit limit and the audit form', async () => {
    const rec = makeQueueFetch([
      { body: { error: { errors: [{ reason: 'quotaExceeded' }] } }, status: 403 },
    ]);
    const result = await youtubeSearchTool.execute({ query: 'cats' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toMatch(/10,000/);
      expect(result.error).toMatch(/audit/i);
    }
  });
});

describe('youtube_search — named-secret binding resolution', () => {
  function makeRecordingSecrets(value = 'bound-key') {
    const refs: string[] = [];
    return {
      refs,
      get: async (ref: string) => {
        refs.push(ref);
        return value;
      },
    };
  }
  const withPersonality = (
    scopedFetch: ScopedFetchLike,
    secrets: typeof mockSecrets,
    pid: string,
  ) =>
    ({ ...ctxWith(scopedFetch, secrets), personalityId: pid }) as typeof ctx & {
      personalityId: string;
    };

  it('a bound secret NAME resolves providers/google/<name>, never a value', async () => {
    const rec = makeQueueFetch([{ body: { items: [] } }]);
    const secrets = makeRecordingSecrets('super-secret');
    const tool = createYouTubeSearchTool({
      resolvePersonalitySetting: (pid) => (pid === 'scout' ? { secret: 'yt-main' } : undefined),
    });
    await tool.execute({ query: 'q' }, withPersonality(rec.scopedFetch, secrets, 'scout'));
    expect(secrets.refs).toEqual(['providers/google/yt-main']);
  });

  it('personality binding beats toolSettings[pid]', async () => {
    const rec = makeQueueFetch([{ body: { items: [] } }]);
    const secrets = makeRecordingSecrets();
    const tool = createYouTubeSearchTool({
      resolvePersonalitySetting: (pid) =>
        pid === 'scout' ? { secret: 'from-personality' } : undefined,
      toolSettings: { scout: { youtube: { secret: 'from-tool-settings' } } },
    });
    await tool.execute({ query: 'q' }, withPersonality(rec.scopedFetch, secrets, 'scout'));
    expect(secrets.refs).toEqual(['providers/google/from-personality']);
  });

  it('toolSettings[pid] beats toolSettings._default', async () => {
    const rec = makeQueueFetch([{ body: { items: [] } }]);
    const secrets = makeRecordingSecrets();
    const tool = createYouTubeSearchTool({
      toolSettings: {
        scout: { youtube: { secret: 'from-pid' } },
        _default: { youtube: { secret: 'from-default' } },
      },
    });
    await tool.execute({ query: 'q' }, withPersonality(rec.scopedFetch, secrets, 'scout'));
    expect(secrets.refs).toEqual(['providers/google/from-pid']);
  });

  it('toolSettings._default beats the default-named key', async () => {
    const rec = makeQueueFetch([{ body: { items: [] } }]);
    const secrets = makeRecordingSecrets();
    const tool = createYouTubeSearchTool({
      toolSettings: { _default: { youtube: { secret: 'from-default' } } },
    });
    await tool.execute({ query: 'q' }, ctxWith(rec.scopedFetch, secrets));
    expect(secrets.refs).toEqual(['providers/google/from-default']);
  });

  it('falls back to providers/google/apiKey when no binding names a secret', async () => {
    const rec = makeQueueFetch([{ body: { items: [] } }]);
    const secrets = makeRecordingSecrets();
    await youtubeSearchTool.execute({ query: 'q' }, ctxWith(rec.scopedFetch, secrets));
    expect(secrets.refs).toEqual(['providers/google/apiKey']);
  });

  // Behaviour CHANGE, search-console.md §13 PR0: selectYouTubeSecretRef used
  // to take the first rung whose setting object existed and land on
  // DEFAULT_SECRET_REF if its name was blank or malformed, skipping the rungs
  // below. It now shares engine_ask's per-rung validation via
  // resolveToolSecretRef. Covers youtube_comments too — one shared resolver.
  it('an invalid secret name falls through to the next rung instead of escaping the prefix', async () => {
    const rec = makeQueueFetch([{ body: { items: [] } }, { body: { items: [] } }]);
    const secrets = makeRecordingSecrets();
    const tool = createYouTubeSearchTool({
      resolvePersonalitySetting: () => ({ secret: '../xai/apiKey' }),
      toolSettings: {
        scout: { youtube: { secret: 'has space' } },
        _default: { youtube: { secret: 'from-default' } },
      },
    });
    await tool.execute({ query: 'q' }, withPersonality(rec.scopedFetch, secrets, 'scout'));
    expect(secrets.refs).toEqual(['providers/google/from-default']);

    const allInvalid = createYouTubeSearchTool({
      resolvePersonalitySetting: () => ({ secret: 'a/b' }),
      toolSettings: { _default: { youtube: { secret: '' } } },
    });
    await allInvalid.execute({ query: 'q' }, withPersonality(rec.scopedFetch, secrets, 'scout'));
    expect(secrets.refs.at(-1)).toBe('providers/google/apiKey');
  });
});

describe('youtube_search — uses ctx.scopedFetch, never globalThis.fetch', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('never calls the global fetch', async () => {
    const spy = vi.fn(async () => {
      throw new Error('global fetch must not be called');
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    const rec = makeQueueFetch([{ body: { items: [] } }]);
    const result = await youtubeSearchTool.execute({ query: 'q' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});
