// UBP-030 — the shared pre-first-byte retry the fetch-based providers
// (llm-codex, llm-gemini, llm-bedrock) import from @ethosagent/core.

import { describe, expect, it, vi } from 'vitest';
import { fetchWithTransientRetry } from '../index';

const noSleep = { sleep: async () => undefined };

describe('fetchWithTransientRetry', () => {
  it('retries a 503 and returns the first good response', async () => {
    const doFetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await fetchWithTransientRetry(doFetch, undefined, noSleep);
    expect(res.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it('never retries a 400', async () => {
    const doFetch = vi.fn(async () => new Response('bad', { status: 400 }));
    const res = await fetchWithTransientRetry(doFetch, undefined, noSleep);
    expect(res.status).toBe(400);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it('stops after maxRetries and returns the last response', async () => {
    const doFetch = vi.fn(async () => new Response('busy', { status: 429 }));
    const res = await fetchWithTransientRetry(doFetch, undefined, { ...noSleep, maxRetries: 2 });
    expect(res.status).toBe(429);
    expect(doFetch).toHaveBeenCalledTimes(3);
  });

  it('honours retry-after, capped at 10s', async () => {
    const waits: number[] = [];
    const doFetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response('slow down', { status: 429, headers: { 'retry-after': '60' } }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await fetchWithTransientRetry(doFetch, undefined, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(waits).toEqual([10_000]);
  });

  it('never retries an abort', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const doFetch = vi.fn(async () => {
      throw abort;
    });
    await expect(fetchWithTransientRetry(doFetch, undefined, noSleep)).rejects.toBe(abort);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });
});
