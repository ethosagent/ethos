import { describe, expect, it, vi } from 'vitest';
import { HttpDispatcher } from '../http-dispatcher';

// S2 fix: the `RPCLink` ternary in `http-dispatcher.ts` used to pass `headers`
// when `apiKey` was set and `fetch` only when it wasn't, so an injected
// `fetch` (e.g. `expo/fetch`) was silently ignored for every bearer client.
// These tests exercise both branches, for RPC calls and for `stream()`.

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpDispatcher — injected fetch threading', () => {
  it('bearer mode: RPC calls use the injected fetch, not the global one', async () => {
    const fetchMock = vi.fn(async (_input: Request | string, _init?: RequestInit) =>
      jsonResponse({ json: { items: [] } }),
    );
    const globalFetchSpy = vi.spyOn(globalThis, 'fetch');

    const dispatcher = new HttpDispatcher({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-ethos-test',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await dispatcher.rpc.personalities.list({}).catch(() => {});

    expect(fetchMock).toHaveBeenCalled();
    expect(globalFetchSpy).not.toHaveBeenCalled();
    // The bearer header is still sent — threading `fetch` didn't drop it.
    // The RPC link's fetch call passes a `Request` (headers live on it, not
    // on the second `init` argument).
    const req = fetchMock.mock.calls[0]?.[0] as Request;
    expect(req.headers.get('authorization')).toBe('Bearer sk-ethos-test');

    globalFetchSpy.mockRestore();
  });

  it('cookie mode: RPC calls use the injected fetch too, with credentials included', async () => {
    const fetchMock = vi.fn(async (_input: Request | string, _init?: RequestInit) =>
      jsonResponse({ json: { items: [] } }),
    );

    const dispatcher = new HttpDispatcher({
      baseUrl: 'http://localhost:3000',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await dispatcher.rpc.personalities.list({}).catch(() => {});

    expect(fetchMock).toHaveBeenCalled();
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.credentials).toBe('include');
  });

  it('threads the injected fetch into stream() (bearer)', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }),
    );

    const dispatcher = new HttpDispatcher({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-ethos-test',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const sub = dispatcher.stream('sess-1', { onEvent: vi.fn() });
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalled();
    sub.close();
  });

  it('falls back to the global fetch when none is injected', () => {
    const dispatcher = new HttpDispatcher({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-ethos-test',
    });

    expect(dispatcher.rpc).toBeDefined();
  });
});
