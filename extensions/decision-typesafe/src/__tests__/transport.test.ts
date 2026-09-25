// Plan §14 "Transport": status map with exactly one request, no retries (R5),
// budget → timeout, caller signal → aborted, wire path/headers/`noul`.

import { describe, expect, it } from 'vitest';
import { createTypesafeDecisionProvider } from '../provider';
import { postSystemOne, systemOneUrl } from '../transport';
import { BOOL_Q, hang, json, noulOk, stubFetch } from './stub';

function provider(fetch: ReturnType<typeof stubFetch>['fetch'], timeoutMs = 2000) {
  return createTypesafeDecisionProvider({ apiKey: 'k', fetch, timeoutMs });
}

describe('status map — exactly one request, never retried', () => {
  it.each([
    [401, 'auth'],
    [422, 'invalid'],
    [429, 'rate_limited'],
    [529, 'overloaded'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [404, 'unavailable'],
  ] as const)('HTTP %i → %s with one request', async (status, code) => {
    const stub = stubFetch(() => json({ error: 'x' }, status));
    const r = await provider(stub.fetch).decide({ state: 's', questions: BOOL_Q });
    expect(r).toMatchObject({ ok: false, code });
    expect(stub.requests).toHaveLength(1);
  });

  it.each([
    [429, 'rate_limited'],
    [529, 'overloaded'],
  ] as const)('HTTP %i returns at once, with no backoff wait (R5)', async (status, code) => {
    const stub = stubFetch(() => json({}, status));
    const started = performance.now();
    const r = await provider(stub.fetch).decide({ state: 's', questions: BOOL_Q });
    expect(performance.now() - started).toBeLessThan(100);
    expect(r).toMatchObject({ ok: false, code });
    expect(stub.requests).toHaveLength(1);
  });

  it('a network error → unavailable, one request', async () => {
    const stub = stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const r = await provider(stub.fetch).decide({ state: 's', questions: BOOL_Q });
    expect(r).toMatchObject({ ok: false, code: 'unavailable' });
    expect(stub.requests).toHaveLength(1);
  });

  it('an unparseable 200 body → malformed', async () => {
    const stub = stubFetch(() => new Response('not json{', { status: 200 }));
    const r = await provider(stub.fetch).decide({ state: 's', questions: BOOL_Q });
    expect(r).toMatchObject({ ok: false, code: 'malformed' });
  });
});

describe('budget and signal', () => {
  it('the budget elapsing → timeout', async () => {
    const stub = stubFetch(hang);
    const r = await provider(stub.fetch).decide({ state: 's', questions: BOOL_Q, timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, code: 'timeout' });
    expect(stub.requests).toHaveLength(1);
  });

  it("the provider's default budget applies when the request sets none", async () => {
    const stub = stubFetch(hang);
    const r = await provider(stub.fetch, 20).decide({ state: 's', questions: BOOL_Q });
    expect(r).toMatchObject({ ok: false, code: 'timeout' });
  });

  it("the caller's signal aborting mid-request → aborted", async () => {
    const stub = stubFetch(hang);
    const controller = new AbortController();
    const pending = provider(stub.fetch).decide({
      state: 's',
      questions: BOOL_Q,
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, code: 'aborted' });
    expect(stub.requests).toHaveLength(1);
  });

  it('an already-aborted signal → aborted with no request', async () => {
    const stub = stubFetch(() => noulOk());
    const controller = new AbortController();
    controller.abort();
    const r = await provider(stub.fetch).decide({
      state: 's',
      questions: BOOL_Q,
      signal: controller.signal,
    });
    expect(r).toMatchObject({ ok: false, code: 'aborted' });
    expect(stub.requests).toHaveLength(0);
  });
});

describe('the wire', () => {
  it('sends `noul`, the headers and the path under a non-default baseUrl', async () => {
    const stub = stubFetch(() => noulOk());
    const p = createTypesafeDecisionProvider({
      apiKey: 'sk-test-123',
      baseUrl: 'https://gw.example.com/proxy/typesafe/',
      model: 'jev-1.3',
      fetch: stub.fetch,
    });
    const r = await p.decide({
      state: { tool: 'read_file', output: 'hello' },
      questions: {
        injection: {
          type: 'boolean',
          instructions: 'Instructs an agent?',
          criteria: { true: 'yes', false: 'no' },
        },
      },
    });
    expect(r.ok).toBe(true);
    const [req] = stub.requests;
    expect(req?.url).toBe('https://gw.example.com/proxy/typesafe/v1/systemone');
    expect(req?.init.method).toBe('POST');
    expect(req?.init.headers).toEqual({
      Authorization: 'Bearer sk-test-123',
      'Content-Type': 'application/json',
    });
    expect(req?.body).toEqual({
      // Object state goes on the wire as-is, not stringified.
      state: { tool: 'read_file', output: 'hello' },
      model: 'jev-1.3',
      questions: {
        injection: {
          type: 'noul',
          instructions: 'Instructs an agent?',
          criteria: { true: 'yes', false: 'no' },
        },
      },
    });
  });

  it('defaults to jev-latest at api.typesafe.ai', async () => {
    const stub = stubFetch(() => noulOk());
    const r = await createTypesafeDecisionProvider({ apiKey: 'k', fetch: stub.fetch }).decide({
      state: 's',
      questions: BOOL_Q,
    });
    expect(r.ok).toBe(true);
    expect(stub.requests[0]?.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(stub.requests[0]?.body.model).toBe('jev-latest');
  });

  it('systemOneUrl strips any number of trailing slashes', () => {
    expect(systemOneUrl('https://a.b')).toBe('https://a.b/v1/systemone');
    expect(systemOneUrl('https://a.b//')).toBe('https://a.b/v1/systemone');
  });

  it('postSystemOne returns the parsed body on 2xx', async () => {
    const stub = stubFetch(() => json({ hello: 'world' }));
    const r = await postSystemOne({
      baseUrl: 'https://a.b',
      apiKey: 'k',
      body: { state: 's', model: 'm', questions: {} },
      timeoutMs: 1000,
      fetch: stub.fetch,
    });
    expect(r).toEqual({ ok: true, body: { hello: 'world' } });
  });
});
