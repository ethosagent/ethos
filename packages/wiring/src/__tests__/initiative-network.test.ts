import { InMemoryStorage } from '@ethosagent/storage-fs';
import { ALL_BACKENDS } from '@ethosagent/tools-web';
import type {
  InitiativeLedgerPort,
  MemoryProvider,
  SessionStore,
  Tool,
  ToolContext,
} from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildReadOnlyRegistry, defaultInitiativeToolFactories } from '../initiatives';

// Memory and session factories read no dependency at construction.
const factories = defaultInitiativeToolFactories({
  env: {},
  toolsConfig: () => undefined,
  memory: {} as MemoryProvider,
  session: {} as SessionStore,
});
const registry = buildReadOnlyRegistry({
  personality: { id: 'open', name: 'open' },
  ledger: {} as InitiativeLedgerPort,
  initiativeId: 'i1',
  sourcePaths: [],
  factories,
  storage: new InMemoryStorage(),
  dataDir: '/ethos-state',
});
const runTools = registry.getAvailable();

/** Argument names that would carry a caller-chosen network destination. */
const DESTINATION_ARG = /url|uri|link|endpoint|host|domain|address/i;

function props(tool: Tool): string[] {
  const p = (tool.schema as { properties?: Record<string, unknown> }).properties;
  return Object.keys(p ?? {});
}

function ctxWith(fetchSpy: ReturnType<typeof vi.fn>, secrets: Record<string, string>): ToolContext {
  return {
    sessionId: 's',
    sessionKey: 'cli:s',
    platform: 'cli',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    secretsResolver: { get: async (ref: string) => secrets[ref] },
    scopedFetch: { fetch: fetchSpy },
  } as unknown as ToolContext;
}

afterEach(() => vi.restoreAllMocks());

describe('initiative run network surface (L6)', () => {
  it('only fetch tool is web_extract', () => {
    // reddit_thread's `permalink` is the one other destination-looking argument.
    // It is reduced to a post id (parseRedditPostId) and the request host is
    // fixed; the next test pins that, so it is a named exception, not a fetcher.
    const takesDestination = runTools
      .filter((t) => props(t).some((n) => DESTINATION_ARG.test(n)))
      .map((t) => t.name)
      .sort();
    expect(takesDestination).toEqual(['reddit_thread', 'web_extract']);
  });

  it('reddit_thread reduces its permalink to an id and only calls reddit hosts', async () => {
    const hosts: string[] = [];
    const fetchSpy = vi.fn(async (url: string | URL) => {
      hosts.push(new URL(String(url)).host);
      return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    });
    const tool = registry.get('reddit_thread') as Tool;
    const ctx = ctxWith(fetchSpy, new Proxy({}, { get: () => 'secret' }) as Record<string, string>);
    await tool.execute({ permalink: 'https://evil.example/comments/abc123/x' }, ctx);
    const refused = await tool.execute({ permalink: 'https://evil.example/nothing' }, ctx);
    expect(refused.ok).toBe(false);
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(['www.reddit.com', 'oauth.reddit.com']).toContain(host);
  });

  it('web_extract schema has only url', () => {
    const tool = registry.get('web_extract');
    expect(tool).toBeDefined();
    expect(props(tool as Tool)).toEqual(['url']);
  });

  it('private address refused', async () => {
    const fetchSpy = vi.fn();
    const tool = registry.get('web_extract') as Tool;
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:8080/']) {
      const result = await tool.execute({ url }, ctxWith(fetchSpy, {}));
      expect(result.ok, url).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/SSRF blocked/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('search backends call fixed hosts', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    const expected: Record<string, string> = {
      exa: 'api.exa.ai',
      tavily: 'api.tavily.com',
      brave: 'api.search.brave.com',
    };
    for (const b of ALL_BACKENDS)
      expect(expected[b.id], `no expected host for ${b.id}`).toBeDefined();
    for (const id of ALL_BACKENDS.map((b) => b.id)) {
      const backend = ALL_BACKENDS.find((b) => b.id === id);
      expect(backend, id).toBeDefined();
      calls.length = 0;
      await backend?.search(
        'q https://evil.example/x',
        3,
        ctxWith(fetchSpy, { [`providers/${id}/apiKey`]: 'k' }),
        `providers/${id}/apiKey`,
      );
      expect(calls).toHaveLength(1);
      expect(new URL(calls[0]?.url ?? '').host).toBe(expected[id]);
      expect(calls[0]?.method ?? 'GET').toBe(id === 'brave' ? 'GET' : 'POST');
    }
  });
});
