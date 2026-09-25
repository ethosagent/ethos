// Plan §14 "Breaker (R3)", with the R9 timeout-counting rule.

import type { DecisionRequest } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { DecisionBreakerEvent } from '../breaker';
import { createTypesafeDecisionProvider } from '../provider';
import { BOOL_Q, hang, json, noulOk, type RecordedRequest, stubFetch } from './stub';

const REQ: DecisionRequest = { state: 's', questions: BOOL_Q };
const DEFAULT_BUDGET = 30;

function setup(responder: (req: RecordedRequest) => Response | Promise<Response>) {
  const clock = { t: 1_000_000 };
  const events: DecisionBreakerEvent[] = [];
  const stub = stubFetch((r) => mode.current(r));
  const mode = { current: responder };
  const provider = createTypesafeDecisionProvider({
    apiKey: 'k',
    fetch: stub.fetch,
    timeoutMs: DEFAULT_BUDGET,
    now: () => clock.t,
    onEvent: (e) => events.push(e),
  });
  return { clock, events, stub, provider, mode };
}

const HEALTH: Array<[string, (req: RecordedRequest) => Response | Promise<Response>]> = [
  ['auth', () => json({}, 401)],
  ['unavailable', () => json({}, 503)],
  ['overloaded', () => json({}, 529)],
  ['rate_limited', () => json({}, 429)],
  ['timeout', hang],
];

describe('opening', () => {
  it.each(HEALTH)(
    '3 consecutive %s → the 4th call makes no request and is unavailable',
    async (code, responder) => {
      const { stub, provider, events } = setup(responder);
      for (let i = 0; i < 3; i++) expect(await provider.decide(REQ)).toMatchObject({ code });
      expect(events).toEqual([{ type: 'decision.breaker_open', code }]);

      const fourth = await provider.decide(REQ);
      expect(fourth).toMatchObject({ ok: false, code: 'unavailable' });
      expect(stub.requests).toHaveLength(3);
    },
  );

  it('invalid, malformed, too_large and aborted never count', async () => {
    const { stub, provider, events, mode } = setup(() => json({}, 422));
    for (let i = 0; i < 4; i++)
      expect(await provider.decide(REQ)).toMatchObject({ code: 'invalid' });

    mode.current = () => new Response('nope', { status: 200 });
    for (let i = 0; i < 4; i++)
      expect(await provider.decide(REQ)).toMatchObject({ code: 'malformed' });

    for (let i = 0; i < 4; i++) {
      const r = await provider.decide({ state: 'a'.repeat(200_000), questions: BOOL_Q });
      expect(r).toMatchObject({ code: 'too_large' });
    }

    mode.current = hang;
    for (let i = 0; i < 4; i++) {
      const c = new AbortController();
      const pending = provider.decide({ ...REQ, signal: c.signal });
      c.abort();
      expect(await pending).toMatchObject({ code: 'aborted' });
    }

    const before = stub.requests.length;
    mode.current = () => noulOk();
    expect(await provider.decide(REQ)).toMatchObject({ ok: true });
    expect(stub.requests).toHaveLength(before + 1);
    expect(events).toEqual([]);
  });

  it('a timeout on a budget below the default never counts (R9)', async () => {
    const { stub, provider, events } = setup(hang);
    for (let i = 0; i < 5; i++) {
      expect(await provider.decide({ ...REQ, timeoutMs: 10 })).toMatchObject({ code: 'timeout' });
    }
    expect(stub.requests).toHaveLength(5);
    expect(events).toEqual([]);
  });

  it('a success resets the count', async () => {
    const { stub, provider, events, mode } = setup(() => json({}, 503));
    await provider.decide(REQ);
    await provider.decide(REQ);
    mode.current = () => noulOk();
    await provider.decide(REQ);
    mode.current = () => json({}, 503);
    await provider.decide(REQ);
    await provider.decide(REQ);
    expect(stub.requests).toHaveLength(5);
    expect(events).toEqual([]);
    // The third consecutive failure after the reset opens it.
    await provider.decide(REQ);
    expect(events).toEqual([{ type: 'decision.breaker_open', code: 'unavailable' }]);
  });
});

describe('half-open probe', () => {
  async function open(s: ReturnType<typeof setup>) {
    for (let i = 0; i < 3; i++) await s.provider.decide(REQ);
  }

  it('stays open until 60 s have passed', async () => {
    const s = setup(() => json({}, 503));
    await open(s);
    s.clock.t += 59_999;
    expect(await s.provider.decide(REQ)).toMatchObject({ code: 'unavailable' });
    expect(s.stub.requests).toHaveLength(3);
  });

  it('after 60 s one probe goes through; success closes the breaker', async () => {
    const s = setup(() => json({}, 503));
    await open(s);
    s.clock.t += 60_000;
    s.mode.current = () => noulOk();
    expect(await s.provider.decide(REQ)).toMatchObject({ ok: true });
    expect(s.stub.requests).toHaveLength(4);
    expect(s.events).toEqual([
      { type: 'decision.breaker_open', code: 'unavailable' },
      { type: 'decision.breaker_closed' },
    ]);
    expect(await s.provider.decide(REQ)).toMatchObject({ ok: true });
    expect(s.stub.requests).toHaveLength(5);
  });

  it('a failed probe reopens for another 60 s', async () => {
    const s = setup(() => json({}, 401));
    await open(s);
    s.clock.t += 60_000;
    expect(await s.provider.decide(REQ)).toMatchObject({ code: 'auth' });
    expect(s.stub.requests).toHaveLength(4);
    expect(s.events).toEqual([
      { type: 'decision.breaker_open', code: 'auth' },
      { type: 'decision.breaker_open', code: 'auth' },
    ]);

    s.clock.t += 30_000;
    expect(await s.provider.decide(REQ)).toMatchObject({ code: 'unavailable' });
    expect(s.stub.requests).toHaveLength(4);

    s.clock.t += 30_000;
    s.mode.current = () => noulOk();
    expect(await s.provider.decide(REQ)).toMatchObject({ ok: true });
    expect(s.stub.requests).toHaveLength(5);
  });

  it('concurrent calls during the probe get unavailable without a request', async () => {
    const s = setup(() => json({}, 503));
    await open(s);
    s.clock.t += 60_000;
    let release: (r: Response) => void = () => {};
    s.mode.current = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    const probe = s.provider.decide(REQ);
    const concurrent = await s.provider.decide(REQ);
    expect(concurrent).toMatchObject({ ok: false, code: 'unavailable' });
    expect(s.stub.requests).toHaveLength(4);
    release(noulOk());
    expect(await probe).toMatchObject({ ok: true });
  });

  it('a probe ending in a per-request code leaves the next call to probe again', async () => {
    const s = setup(() => json({}, 503));
    await open(s);
    s.clock.t += 60_000;
    s.mode.current = () => json({}, 422);
    expect(await s.provider.decide(REQ)).toMatchObject({ code: 'invalid' });
    s.mode.current = () => noulOk();
    expect(await s.provider.decide(REQ)).toMatchObject({ ok: true });
    expect(s.stub.requests).toHaveLength(5);
  });
});
