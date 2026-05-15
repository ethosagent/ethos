import { describe, expect, it } from 'vitest';
import { createWebTools, webExtractTool, webSearchTool } from '../index';

const mockSecrets = {
  get: async (_ref: string) => 'test-api-key',
};

const mockFetch = {
  fetch: async (url: string | URL, _init?: RequestInit): Promise<Response> => {
    const u = typeof url === 'string' ? url : url.toString();
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`URL_SCHEME_REJECTED: ${parsed.protocol}`);
    }
    return new Response('OK', { status: 200 });
  },
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

describe('createWebTools', () => {
  it('returns 2 tools', () => {
    expect(createWebTools()).toHaveLength(2);
  });
});

describe('web_search', () => {
  it('isAvailable returns false when ETHOS_EXA_API_KEY is not set', () => {
    const saved = process.env.ETHOS_EXA_API_KEY;
    delete process.env.ETHOS_EXA_API_KEY;
    expect(webSearchTool.isAvailable?.()).toBe(false);
    if (saved) process.env.ETHOS_EXA_API_KEY = saved;
  });

  it('isAvailable returns true when ETHOS_EXA_API_KEY is set', () => {
    const saved = process.env.ETHOS_EXA_API_KEY;
    process.env.ETHOS_EXA_API_KEY = 'test-key';
    expect(webSearchTool.isAvailable?.()).toBe(true);
    if (saved) process.env.ETHOS_EXA_API_KEY = saved;
    else delete process.env.ETHOS_EXA_API_KEY;
  });

  it('returns not_available when capability backends are missing', async () => {
    const result = await webSearchTool.execute({ query: 'test' }, ctxWithoutCapabilities);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });

  it('returns input_invalid if query is missing', async () => {
    const result = await webSearchTool.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });
});

describe('web_extract', () => {
  it('returns input_invalid for missing url', async () => {
    const result = await webExtractTool.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('returns not_available when capability backends are missing', async () => {
    const result = await webExtractTool.execute(
      { url: 'https://example.com' },
      ctxWithoutCapabilities,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });

  it('propagates fetch errors for malformed urls', async () => {
    const result = await webExtractTool.execute({ url: 'not-a-url' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
    }
  });

  it('propagates fetch errors for non-http protocols', async () => {
    const result = await webExtractTool.execute({ url: 'ftp://example.com' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toMatch(/URL_SCHEME_REJECTED/);
    }
  });
});
