import { afterEach, describe, expect, it, vi } from 'vitest';
import { createYouTubeCommentsTool, youtubeCommentsTool } from '../index';

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

function makeRecordingFetch(responseBody: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: typeof url === 'string' ? url : url.toString(), init });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { scopedFetch: { fetch }, calls };
}

const VIDEO_ID = 'dQw4w9WgXcQ';

const THREAD_NO_REPLIES = {
  snippet: {
    topLevelComment: {
      snippet: {
        authorDisplayName: 'Alice',
        likeCount: 10,
        publishedAt: '2026-01-01T00:00:00Z',
        textOriginal: 'Great video!',
      },
    },
    totalReplyCount: 1,
  },
};

const THREAD_WITH_REPLIES = {
  ...THREAD_NO_REPLIES,
  replies: {
    comments: [
      {
        snippet: {
          authorDisplayName: 'Bob',
          likeCount: 2,
          publishedAt: '2026-01-02T00:00:00Z',
          textOriginal: 'I agree!',
        },
      },
    ],
  },
};

// ---------------------------------------------------------------------------

describe('youtube_comments — availability', () => {
  it('isAvailable always returns true', () => {
    expect(youtubeCommentsTool.isAvailable?.()).toBe(true);
  });

  it('returns not_available when capability backends are missing', async () => {
    const result = await youtubeCommentsTool.execute({ video: VIDEO_ID }, ctxWithoutCapabilities);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });
});

describe('youtube_comments — input validation', () => {
  it('returns input_invalid if video is missing', async () => {
    const result = await youtubeCommentsTool.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('returns input_invalid, echoing the offending input, for a video argument no URL form matches', async () => {
    const rec = makeRecordingFetch({});
    const result = await youtubeCommentsTool.execute(
      { video: 'https://example.com/not-a-video' },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('input_invalid');
      expect(result.error).toContain('https://example.com/not-a-video');
    }
    expect(rec.calls).toHaveLength(0);
  });

  it('accepts a full YouTube URL and resolves it to the video id', async () => {
    const rec = makeRecordingFetch({ items: [THREAD_NO_REPLIES] });
    const result = await youtubeCommentsTool.execute(
      { video: `https://www.youtube.com/watch?v=${VIDEO_ID}` },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    expect(rec.calls[0]?.url).toContain(`videoId=${VIDEO_ID}`);
  });
});

describe('youtube_comments — no key configured', () => {
  it('produces a clear error naming Named Secrets and YOUTUBE_API_KEY', async () => {
    const rec = makeRecordingFetch({});
    const noKeySecrets = { get: async (_ref: string) => '' };
    const result = await youtubeCommentsTool.execute(
      { video: VIDEO_ID },
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

describe('youtube_comments — request shape', () => {
  it('hits googleapis.com/youtube/v3/commentThreads with the video id, part, order, maxResults and key', async () => {
    const rec = makeRecordingFetch({ items: [THREAD_NO_REPLIES] });
    await youtubeCommentsTool.execute({ video: VIDEO_ID }, ctxWith(rec.scopedFetch));
    const url = rec.calls[0]?.url ?? '';
    expect(url).toContain('https://www.googleapis.com/youtube/v3/commentThreads?');
    expect(url).toContain(`videoId=${VIDEO_ID}`);
    expect(url).toContain('part=snippet');
    expect(url).toContain('order=relevance');
    expect(url).toContain('maxResults=20');
    expect(url).toContain('key=test-api-key');
  });

  it('clamps limit at the cap (100)', async () => {
    const rec = makeRecordingFetch({ items: [] });
    await youtubeCommentsTool.execute({ video: VIDEO_ID, limit: 500 }, ctxWith(rec.scopedFetch));
    expect(rec.calls[0]?.url).toContain('maxResults=100');
  });

  it('include_replies: false requests part=snippet and renders no replies', async () => {
    const rec = makeRecordingFetch({ items: [THREAD_WITH_REPLIES] });
    const result = await youtubeCommentsTool.execute(
      { video: VIDEO_ID, include_replies: false },
      ctxWith(rec.scopedFetch),
    );
    expect(rec.calls[0]?.url).toContain('part=snippet');
    expect(rec.calls[0]?.url).not.toContain('part=snippet%2Creplies');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).not.toContain('Bob');
  });

  it('include_replies: true requests part=snippet,replies and indents them', async () => {
    const rec = makeRecordingFetch({ items: [THREAD_WITH_REPLIES] });
    const result = await youtubeCommentsTool.execute(
      { video: VIDEO_ID, include_replies: true },
      ctxWith(rec.scopedFetch),
    );
    expect(rec.calls[0]?.url).toContain('part=snippet%2Creplies');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('Alice');
      expect(result.value).toMatch(/ {2}- Bob/);
    }
  });
});

describe('youtube_comments — rendering', () => {
  it('renders author, like count, date and text', async () => {
    const rec = makeRecordingFetch({ items: [THREAD_NO_REPLIES] });
    const result = await youtubeCommentsTool.execute({ video: VIDEO_ID }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('Alice');
      expect(result.value).toContain('10 likes');
      expect(result.value).toContain('2026-01-01');
      expect(result.value).toContain('Great video!');
    }
  });

  it('reports "No comments found" as ok:true for an empty thread list', async () => {
    const rec = makeRecordingFetch({ items: [] });
    const result = await youtubeCommentsTool.execute({ video: VIDEO_ID }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatch(/No comments found/);
  });

  it('states the page count in the footer', async () => {
    const rec = makeRecordingFetch({ items: [THREAD_NO_REPLIES] });
    const result = await youtubeCommentsTool.execute({ video: VIDEO_ID }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatch(/1 units \(1 page\)/);
  });
});

describe('youtube_comments — error mapping', () => {
  it('maps 403 keyInvalid to not_available', async () => {
    const rec = makeRecordingFetch({ error: { errors: [{ reason: 'keyInvalid' }] } }, 403);
    const result = await youtubeCommentsTool.execute({ video: VIDEO_ID }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });

  it('maps 403 quotaExceeded to execution_failed naming the 10,000-unit limit and the audit form', async () => {
    const rec = makeRecordingFetch({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403);
    const result = await youtubeCommentsTool.execute({ video: VIDEO_ID }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toMatch(/10,000/);
      expect(result.error).toMatch(/audit/i);
    }
  });
});

describe('youtube_comments — named-secret binding resolution', () => {
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
    const rec = makeRecordingFetch({ items: [] });
    const secrets = makeRecordingSecrets('super-secret');
    const tool = createYouTubeCommentsTool({
      resolvePersonalitySetting: (pid) => (pid === 'scout' ? { secret: 'yt-main' } : undefined),
    });
    await tool.execute({ video: VIDEO_ID }, withPersonality(rec.scopedFetch, secrets, 'scout'));
    expect(secrets.refs).toEqual(['providers/google/yt-main']);
  });

  it('falls back to providers/google/apiKey when no binding names a secret', async () => {
    const rec = makeRecordingFetch({ items: [] });
    const secrets = makeRecordingSecrets();
    await youtubeCommentsTool.execute({ video: VIDEO_ID }, ctxWith(rec.scopedFetch, secrets));
    expect(secrets.refs).toEqual(['providers/google/apiKey']);
  });
});

describe('youtube_comments — uses ctx.scopedFetch, never globalThis.fetch', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('never calls the global fetch', async () => {
    const spy = vi.fn(async () => {
      throw new Error('global fetch must not be called');
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    const rec = makeRecordingFetch({ items: [] });
    const result = await youtubeCommentsTool.execute({ video: VIDEO_ID }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});
