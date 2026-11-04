import { describe, expect, it, vi } from 'vitest';
import { pullOllamaModel } from '../ollama-pull';

const MODEL = 'llama3.2';

// Recorded-style /api/pull NDJSON (Ollama streams one JSON object per line).
const RECORDED = [
  '{"status":"pulling manifest"}',
  '{"status":"pulling dde5aa3fc5ff","digest":"sha256:dde5aa3fc5ff","total":2019377376,"completed":0}',
  '{"status":"pulling dde5aa3fc5ff","digest":"sha256:dde5aa3fc5ff","total":2019377376,"completed":1009688688}',
  '{"status":"verifying sha256 digest"}',
  '{"status":"writing manifest"}',
  '{"status":"success"}',
  '',
].join('\n');

function streamOf(chunks: string[], signal?: AbortSignal): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      if (!signal) c.close();
      else signal.addEventListener('abort', () => c.error(signal.reason), { once: true });
    },
  });
  return new Response(body, { status: 200 });
}

describe('pullOllamaModel', () => {
  it('parses progress lines and resolves on success', async () => {
    const seen: unknown[] = [];
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ model: MODEL, stream: true });
      // split mid-line to exercise buffering
      return streamOf([RECORDED.slice(0, 50), RECORDED.slice(50)]);
    });
    await pullOllamaModel({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: MODEL,
      onProgress: (p) => seen.push(p),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://127.0.0.1:11434/api/pull');
    expect(seen).toHaveLength(6);
    expect(seen[2]).toEqual({
      status: 'pulling dde5aa3fc5ff',
      digest: 'sha256:dde5aa3fc5ff',
      total: 2019377376,
      completed: 1009688688,
    });
  });

  it('rejects on an error line', async () => {
    const fetchImpl = async () =>
      streamOf([
        '{"status":"pulling manifest"}\n{"error":"pull model manifest: file does not exist"}\n',
      ]);
    await expect(
      pullOllamaModel({
        baseUrl: 'http://127.0.0.1:11434',
        model: MODEL,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow('file does not exist');
  });

  it('aborts on signal', async () => {
    const ac = new AbortController();
    const fetchImpl = async (_u: unknown, init?: RequestInit) =>
      streamOf(['{"status":"pulling manifest"}\n'], init?.signal ?? undefined);
    const p = pullOllamaModel({
      baseUrl: 'http://127.0.0.1:11434',
      model: MODEL,
      signal: ac.signal,
      onProgress: () => ac.abort(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(p).rejects.toThrow();
  });

  it('refuses a model outside the tier table', async () => {
    const fetchImpl = vi.fn();
    await expect(
      pullOllamaModel({
        baseUrl: 'http://127.0.0.1:11434',
        model: 'evil/model',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/tier table/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a non-local base URL', async () => {
    const fetchImpl = vi.fn();
    for (const baseUrl of [
      'http://example.com:11434',
      'http://10.0.0.5:11434',
      'http://169.254.169.254',
    ]) {
      await expect(
        pullOllamaModel({ baseUrl, model: MODEL, fetchImpl: fetchImpl as unknown as typeof fetch }),
      ).rejects.toThrow();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
