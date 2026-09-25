// `runDecisionSite` (plan/phases/decision-provider-jev.md §14 "Site helper",
// R4) — the full mode × threshold × calibrated × failure × shadow matrix,
// tested once here. Each site tests only its own mapping.

import type {
  AgentEvent,
  DecisionAnswer,
  DecisionErrorCode,
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  DecisionSink,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import {
  type DecisionCallRecord,
  DecisionRecordTracker,
  meetsThreshold,
  type RunDecisionSiteOptions,
  runDecisionSite,
} from '../decision-site';

const ERROR_CODES: DecisionErrorCode[] = [
  'auth',
  'invalid',
  'rate_limited',
  'overloaded',
  'timeout',
  'aborted',
  'malformed',
  'too_large',
  'unavailable',
  'breaker_open',
];

function okResult(p: number, model = 'jev-1.13.0'): DecisionResult {
  return {
    ok: true,
    answers: { q: { type: 'boolean', p, confidence: Math.abs(2 * p - 1) } },
    model,
    usage: { inputTokens: 1_000_000, outputTokens: 1 },
  };
}

function stubProvider(
  respond: (req: DecisionRequest) => Promise<DecisionResult> | DecisionResult,
  calibrated = true,
) {
  const requests: DecisionRequest[] = [];
  const decide = vi.fn(async (req: DecisionRequest) => {
    requests.push(req);
    return respond(req);
  });
  const provider: DecisionProvider = { name: 'stub', calibrated, decide };
  return { provider, decide, requests };
}

function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function booleanOf(answers: Record<string, DecisionAnswer>) {
  const a = answers.q;
  return a?.type === 'boolean' ? a : null;
}

/** A boolean site: verdict is `true`/`false`, threshold 0.8. */
function site(
  overrides: Partial<RunDecisionSiteOptions<boolean, boolean>>,
): RunDecisionSiteOptions<boolean, boolean> & { records: DecisionCallRecord[] } {
  const records: DecisionCallRecord[] = [];
  return {
    site: 'injection',
    mode: 'on',
    provider: undefined,
    digest: { kind: 'text', value: 'hello' },
    questions: { q: { type: 'boolean', instructions: 'Is it?' } },
    timeoutMs: 2000,
    gate: (answers) => {
      const a = booleanOf(answers);
      return a && meetsThreshold(a.confidence, 0.8) ? a.p >= 0.5 : null;
    },
    interpret: (answers) => {
      const a = booleanOf(answers);
      return a ? a.p >= 0.5 : null;
    },
    disagrees: (jev, today) => jev !== today,
    today: async () => false,
    recorder: { recordDecisionCall: (r) => records.push(r) },
    records,
    ...overrides,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('runDecisionSite — off', () => {
  it('mode off never calls the provider and returns today', async () => {
    const { provider, decide } = stubProvider(() => okResult(0.99));
    const opts = site({ mode: 'off', provider, today: async () => false });
    expect(await runDecisionSite(opts)).toBe(false);
    expect(decide).not.toHaveBeenCalled();
    expect(opts.records).toHaveLength(0);
  });

  it('no provider runs today only, whatever the mode', async () => {
    for (const mode of ['shadow', 'on'] as const) {
      const today = vi.fn(async () => true);
      expect(await runDecisionSite(site({ mode, provider: undefined, today }))).toBe(true);
      expect(today).toHaveBeenCalledTimes(1);
    }
  });
});

describe('runDecisionSite — on', () => {
  it('uses the provider verdict at or above the threshold and skips today', async () => {
    const { provider } = stubProvider(() => okResult(0.9)); // confidence 0.8 == T
    const today = vi.fn(async () => false);
    const opts = site({ provider, today });
    expect(await runDecisionSite(opts)).toBe(true);
    expect(today).not.toHaveBeenCalled();
    expect(opts.records[0]?.acted).toBe(true);
  });

  it('takes today below the threshold', async () => {
    const { provider } = stubProvider(() => okResult(0.85)); // confidence 0.7 < 0.8
    const today = vi.fn(async () => false);
    const opts = site({ provider, today });
    expect(await runDecisionSite(opts)).toBe(false);
    expect(today).toHaveBeenCalledTimes(1);
    expect(opts.records[0]?.acted).toBe(false);
  });

  it('takes today on a missing threshold (meetsThreshold fails closed)', async () => {
    expect(meetsThreshold(1, undefined)).toBe(false);
    const { provider } = stubProvider(() => okResult(1));
    const opts = site({
      provider,
      gate: (a) => {
        const b = booleanOf(a);
        return b && meetsThreshold(b.confidence, undefined) ? true : null;
      },
    });
    expect(await runDecisionSite(opts)).toBe(false);
  });

  it('takes today on an uncalibrated provider, even at full confidence', async () => {
    const { provider } = stubProvider(() => okResult(1), false);
    const today = vi.fn(async () => false);
    expect(await runDecisionSite(site({ provider, today }))).toBe(false);
    expect(today).toHaveBeenCalledTimes(1);
  });

  it.each(ERROR_CODES)('takes today on error code %s and records it', async (code) => {
    const { provider } = stubProvider(() => ({ ok: false, code, message: 'x' }));
    const opts = site({ provider, today: async () => true });
    expect(await runDecisionSite(opts)).toBe(true);
    expect(opts.records[0]).toMatchObject({ outcome: code, inputTokens: 0, estimatedCostUsd: 0 });
    expect(opts.records[0]?.model).toBeUndefined();
  });

  it('a provider that throws (contract breach) still takes today', async () => {
    const { provider } = stubProvider(() => {
      throw new Error('boom');
    });
    const opts = site({ provider, today: async () => true });
    expect(await runDecisionSite(opts)).toBe(true);
    expect(opts.records[0]?.outcome).toBe('unavailable');
  });

  it('a throwing today() propagates unchanged', async () => {
    const { provider } = stubProvider(() => okResult(0.5));
    const err = new Error('today failed');
    await expect(
      runDecisionSite(
        site({
          provider,
          today: async () => {
            throw err;
          },
        }),
      ),
    ).rejects.toBe(err);
  });

  it('passes the site budget and the signal to decide()', async () => {
    const { provider, requests } = stubProvider(() => okResult(0.99));
    const signal = new AbortController().signal;
    await runDecisionSite(site({ provider, timeoutMs: 500, signal }));
    expect(requests[0]?.timeoutMs).toBe(500);
    expect(requests[0]?.signal).toBe(signal);
  });
});

describe('runDecisionSite — per-call record (D13)', () => {
  it('carries site, provider, returned model, latency, tokens, question count, outcome and cost', async () => {
    let t = 1000;
    const { provider } = stubProvider(() => {
      t += 42;
      return okResult(0.99, 'jev-1.13.0');
    });
    const opts = site({ provider, now: () => t });
    await runDecisionSite(opts);
    expect(opts.records).toEqual([
      {
        site: 'injection',
        mode: 'on',
        provider: 'stub',
        model: 'jev-1.13.0',
        latencyMs: 42,
        inputTokens: 1_000_000,
        questionCount: 1,
        outcome: 'ok',
        // 1M input tokens × $0.042/M, output free (packages/pricing `jev-` row).
        estimatedCostUsd: expect.closeTo(0.042, 10),
        acted: true,
      },
    ]);
  });

  it('a throwing recorder never changes the verdict', async () => {
    const { provider } = stubProvider(() => okResult(0.99));
    const opts = site({
      provider,
      recorder: {
        recordDecisionCall: () => {
          throw new Error('obs down');
        },
      },
    });
    expect(await runDecisionSite(opts)).toBe(true);
  });
});

describe('runDecisionSite — shadow', () => {
  it("runs both, returns today's verdict, and records the disagreement", async () => {
    const { provider, decide } = stubProvider(() => okResult(0.99)); // Jev: true
    const today = vi.fn(async () => false);
    const opts = site({ mode: 'shadow', provider, today });
    expect(await runDecisionSite(opts)).toBe(false);
    await flush();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(today).toHaveBeenCalledTimes(1);
    expect(opts.records[0]).toMatchObject({
      mode: 'shadow',
      outcome: 'ok',
      jevVerdict: true,
      todayVerdict: false,
      disagreed: true,
    });
  });

  it('records agreement as disagreed:false, using the pre-threshold reading', async () => {
    const { provider } = stubProvider(() => okResult(0.6)); // below T, reads true
    const opts = site({ mode: 'shadow', provider, today: async () => true });
    expect(await runDecisionSite(opts)).toBe(true);
    await flush();
    expect(opts.records[0]).toMatchObject({ jevVerdict: true, disagreed: false });
  });

  it('never waits for the provider (R8): a slow decide() does not delay today', async () => {
    const slow = deferred<DecisionResult>();
    const { provider } = stubProvider(() => slow.promise); // stands in for a 1500 ms Jev
    const opts = site({
      mode: 'shadow',
      provider,
      today: () => new Promise<boolean>((r) => setTimeout(() => r(false), 10)),
    });
    const started = Date.now();
    expect(await runDecisionSite(opts)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
    // Nothing recorded yet: Jev has not settled.
    expect(opts.records).toHaveLength(0);

    // Jev settles after the site already returned — still recorded.
    slow.resolve(okResult(0.99));
    await flush();
    expect(opts.records[0]).toMatchObject({
      jevVerdict: true,
      todayVerdict: false,
      disagreed: true,
    });
  });

  it('records a provider failure in shadow with no reading and no disagreement', async () => {
    const { provider } = stubProvider(() => ({ ok: false, code: 'timeout', message: 't' }));
    const opts = site({ mode: 'shadow', provider, today: async () => true });
    expect(await runDecisionSite(opts)).toBe(true);
    await flush();
    expect(opts.records[0]).toMatchObject({ outcome: 'timeout', todayVerdict: true });
    expect(opts.records[0]?.jevVerdict).toBeUndefined();
    expect(opts.records[0]?.disagreed).toBeUndefined();
  });

  it("a throwing today() propagates, and Jev's call is still recorded", async () => {
    const { provider } = stubProvider(() => okResult(0.99));
    const err = new Error('today failed');
    const opts = site({
      mode: 'shadow',
      provider,
      today: async () => {
        throw err;
      },
    });
    await expect(runDecisionSite(opts)).rejects.toBe(err);
    await flush();
    expect(opts.records[0]).toMatchObject({ outcome: 'ok', jevVerdict: true });
    expect(opts.records[0]?.todayVerdict).toBeUndefined();
  });

  it('a provider that rejects in shadow leaks no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { provider } = stubProvider(() => Promise.reject(new Error('boom')));
      const opts = site({ mode: 'shadow', provider, today: async () => true });
      expect(await runDecisionSite(opts)).toBe(true);
      await flush();
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
      expect(opts.records[0]?.outcome).toBe('unavailable');
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('runDecisionSite — redaction before decide() (R2)', () => {
  const KEY = `sk-${'a'.repeat(48)}`;

  it.each(['on', 'shadow'] as const)(
    'a text digest reaches decide() redacted (%s)',
    async (mode) => {
      const { provider, requests } = stubProvider(() => okResult(0.99));
      await runDecisionSite(
        site({ mode, provider, digest: { kind: 'text', value: `the key is ${KEY} ok` } }),
      );
      await flush();
      const sent = JSON.stringify(requests[0]);
      expect(sent).not.toContain(KEY);
      expect(sent).toContain('[REDACTED:openai-key]');
    },
  );

  it('a JSON digest reaches decide() redacted', async () => {
    const { provider, requests } = stubProvider(() => okResult(0.99));
    await runDecisionSite(
      site({
        provider,
        digest: { kind: 'json', value: { command: `curl -H "x: ${KEY}"`, nested: [KEY] } },
      }),
    );
    const sent = JSON.stringify(requests[0]);
    expect(sent).not.toContain(KEY);
    expect(sent).toContain('[REDACTED:openai-key]');
  });
});

// R8 teardown: `ethos -z` exits right after its turn, so a shadow answer that
// lands late must be drainable — while the site call itself still never waits.
describe('runDecisionSite — shadow records tracker (R8 teardown)', () => {
  it('site returns at once; drain resolves once the provider settles and the record exists', async () => {
    const jev = deferred<DecisionResult>();
    const { provider } = stubProvider(() => jev.promise);
    const tracker = new DecisionRecordTracker(2000);
    const opts = site({ mode: 'shadow', provider, today: async () => true, tracker });

    expect(await runDecisionSite(opts)).toBe(true);
    expect(tracker.pending).toBe(1);
    expect(opts.records).toHaveLength(0);

    let drained = false;
    const drain = tracker.drain().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);

    jev.resolve(okResult(0.9));
    await drain;
    expect(opts.records).toHaveLength(1);
    expect(opts.records[0]).toMatchObject({ mode: 'shadow', outcome: 'ok', disagreed: false });
    expect(tracker.pending).toBe(0);
  });

  it('a throwing today still tracks the recording', async () => {
    const jev = deferred<DecisionResult>();
    const { provider } = stubProvider(() => jev.promise);
    const tracker = new DecisionRecordTracker(2000);
    const opts = site({
      mode: 'shadow',
      provider,
      today: async () => {
        throw new Error('today broke');
      },
      tracker,
    });
    await expect(runDecisionSite(opts)).rejects.toThrow('today broke');
    expect(tracker.pending).toBe(1);
    jev.resolve(okResult(0.9));
    await tracker.drain();
    expect(opts.records).toHaveLength(1);
  });

  it('drain(maxMs) returns at the cap without throwing when the provider is slower', async () => {
    const jev = deferred<DecisionResult>();
    const { provider } = stubProvider(() => jev.promise);
    const tracker = new DecisionRecordTracker(2000);
    const opts = site({ mode: 'shadow', provider, today: async () => true, tracker });
    await runDecisionSite(opts);

    const started = Date.now();
    await expect(tracker.drain(30)).resolves.toBeUndefined();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(1000);
    expect(opts.records).toHaveLength(0);
    expect(tracker.pending).toBe(1);

    jev.resolve(okResult(0.9));
    await tracker.drain();
    expect(opts.records).toHaveLength(1);
  });

  it('drain with nothing tracked is an immediate no-op', async () => {
    const tracker = new DecisionRecordTracker(60_000);
    const started = Date.now();
    await tracker.drain();
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('`on` and `off` register nothing', async () => {
    const { provider } = stubProvider(() => okResult(0.99));
    const tracker = new DecisionRecordTracker(2000);
    await runDecisionSite(site({ mode: 'on', provider, tracker }));
    await runDecisionSite(site({ mode: 'off', provider, tracker }));
    expect(tracker.pending).toBe(0);
  });

  it('copies the caller traceId onto the record', async () => {
    const { provider } = stubProvider(() => okResult(0.99));
    const tracker = new DecisionRecordTracker(2000);
    const opts = site({ mode: 'shadow', provider, tracker, traceId: 'trace-1' });
    await runDecisionSite(opts);
    await tracker.drain();
    expect(opts.records[0]?.traceId).toBe('trace-1');
  });
});

// plan decision-provider-personality §15.3 / §15.8 "Wiring" — N7b.
describe('runDecisionSite — decision events through the sink', () => {
  type Body = Parameters<DecisionSink['emit']>[0];

  function sink(traceId?: string) {
    const events: Body[] = [];
    const value: DecisionSink = {
      ...(traceId !== undefined ? { traceId } : {}),
      emit: (e) => events.push(e),
    };
    return { sink: value, events };
  }

  const summarize = {
    verdict: (v: boolean) => (v ? 'flagged' : 'clean'),
    reading: (j: boolean) => (j ? 'flagged' : 'clean'),
  };

  /** A clock that moves only when a path runs: decide() +30, today() +1200. */
  function clocked(result: DecisionResult, today: () => Promise<boolean> = async () => false) {
    let t = 0;
    const { provider } = stubProvider(() => {
      t += 30;
      return result;
    });
    return {
      provider,
      now: () => t,
      today: async () => {
        t += 1200;
        return today();
      },
    };
  }

  it('on, acted: started then ONE settled, sharing an id, with the acted verdict', async () => {
    const { sink: s, events } = sink();
    const c = clocked(okResult(0.95)); // confidence 0.9 ≥ 0.8
    expect(await runDecisionSite(site({ ...c, sink: s, summarize }))).toBe(true);
    expect(events).toEqual([
      { id: expect.any(String), site: 'injection', provider: 'stub', phase: 'started', mode: 'on' },
      {
        id: events[0]?.id,
        site: 'injection',
        provider: 'stub',
        phase: 'settled',
        mode: 'on',
        model: 'jev-1.13.0',
        outcome: 'ok',
        confidence: expect.closeTo(0.9, 10),
        latencyMs: 30,
        acted: true,
        verdict: 'flagged',
      },
    ]);
  });

  it('on, below threshold: acted false, no verdict, the confidence still shown', async () => {
    const { sink: s, events } = sink();
    const c = clocked(okResult(0.85)); // confidence 0.7 < 0.8
    expect(await runDecisionSite(site({ ...c, sink: s, summarize }))).toBe(false);
    const settled = events.at(-1);
    expect(settled).toMatchObject({ phase: 'settled', acted: false, outcome: 'ok' });
    expect(settled?.verdict).toBeUndefined();
    expect(settled?.confidence).toBeCloseTo(0.7, 10);
    expect(settled?.todayLatencyMs).toBeUndefined();
  });

  it('shadow, agreed: no started; reading, today and both latencies', async () => {
    const { sink: s, events } = sink();
    const tracker = new DecisionRecordTracker(2000);
    const c = clocked(okResult(0.1), async () => false); // reads clean, today clean
    const opts = site({ ...c, mode: 'shadow', sink: s, summarize, tracker });
    expect(await runDecisionSite(opts)).toBe(false);
    await tracker.drain();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: 'settled',
      mode: 'shadow',
      outcome: 'ok',
      verdict: 'clean',
      todayVerdict: 'clean',
      disagreed: false,
      // The two paths overlap on one fake clock, so only today's span is exact here.
      latencyMs: expect.any(Number),
      todayLatencyMs: 1200,
    });
    expect(events[0]?.acted).toBeUndefined();
    // The record carries the same measurement (§15.1).
    expect(opts.records[0]?.todayLatencyMs).toBe(1200);
  });

  it('shadow, disagreed: disagreed true, the two verdicts differ', async () => {
    const { sink: s, events } = sink();
    const tracker = new DecisionRecordTracker(2000);
    const c = clocked(okResult(0.99), async () => false);
    await runDecisionSite(site({ ...c, mode: 'shadow', sink: s, summarize, tracker }));
    await tracker.drain();
    expect(events[0]).toMatchObject({ verdict: 'flagged', todayVerdict: 'clean', disagreed: true });
  });

  it('failure: the error outcome, no model, no confidence; in shadow no todayLatencyMs', async () => {
    for (const mode of ['on', 'shadow'] as const) {
      const { sink: s, events } = sink();
      const tracker = new DecisionRecordTracker(2000);
      const c = clocked({ ok: false, code: 'timeout', message: 't' });
      await runDecisionSite(site({ ...c, mode, sink: s, summarize, tracker }));
      await tracker.drain();
      const settled = events.at(-1);
      expect(settled).toMatchObject({ phase: 'settled', mode, outcome: 'timeout' });
      expect(settled?.model).toBeUndefined();
      expect(settled?.confidence).toBeUndefined();
      expect(settled?.todayLatencyMs).toBeUndefined();
      if (mode === 'on') expect(settled?.acted).toBe(false);
    }
  });

  it('breaker_open (PD19) settles as its own outcome and takes today', async () => {
    const { sink: s, events } = sink();
    const today = vi.fn(async () => false);
    const { provider } = stubProvider(() => ({
      ok: false,
      code: 'breaker_open',
      message: 'breaker open',
    }));
    expect(await runDecisionSite(site({ provider, today, sink: s, summarize }))).toBe(false);
    expect(today).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ outcome: 'breaker_open', acted: false });
  });

  it('never a todayLatencyMs for the router (today does no work)', async () => {
    const { sink: s, events } = sink();
    const tracker = new DecisionRecordTracker(2000);
    const c = clocked(okResult(0.99));
    const opts = site({ ...c, site: 'router', mode: 'shadow', sink: s, summarize, tracker });
    await runDecisionSite(opts);
    await tracker.drain();
    expect(events[0]?.site).toBe('router');
    expect(events[0]?.todayLatencyMs).toBeUndefined();
    expect(opts.records[0]?.todayLatencyMs).toBeUndefined();
  });

  it('a throwing today() in shadow: the reading is emitted, with no today verdict or latency', async () => {
    const { sink: s, events } = sink();
    const tracker = new DecisionRecordTracker(2000);
    const c = clocked(okResult(0.99), async () => {
      throw new Error('today failed');
    });
    await expect(
      runDecisionSite(site({ ...c, mode: 'shadow', sink: s, summarize, tracker })),
    ).rejects.toThrow('today failed');
    await tracker.drain();
    expect(events[0]).toMatchObject({ phase: 'settled', verdict: 'flagged' });
    expect(events[0]?.todayVerdict).toBeUndefined();
    expect(events[0]?.todayLatencyMs).toBeUndefined();
  });

  it('a shadow result that settles late is still emitted once it settles (PD17)', async () => {
    const { sink: s, events } = sink();
    const gate = deferred<DecisionResult>();
    const { provider } = stubProvider(() => gate.promise);
    const tracker = new DecisionRecordTracker(2000);
    await runDecisionSite(site({ mode: 'shadow', provider, sink: s, tracker }));
    expect(events).toHaveLength(0);
    gate.resolve(okResult(0.99));
    await tracker.drain();
    expect(events).toHaveLength(1);
  });

  it("the record's traceId falls back to the sink's; the caller's wins when both exist", async () => {
    const { provider } = stubProvider(() => okResult(0.99));
    const a = site({ provider, sink: sink('trace-sink').sink });
    await runDecisionSite(a);
    expect(a.records[0]?.traceId).toBe('trace-sink');
    const b = site({ provider, sink: sink('trace-sink').sink, traceId: 'trace-caller' });
    await runDecisionSite(b);
    expect(b.records[0]?.traceId).toBe('trace-caller');
  });

  it('a throwing sink never changes the verdict; off and no-provider emit nothing', async () => {
    const { provider } = stubProvider(() => okResult(0.99));
    const throwing: DecisionSink = {
      emit: () => {
        throw new Error('sink down');
      },
    };
    expect(await runDecisionSite(site({ provider, sink: throwing }))).toBe(true);
    for (const opts of [site({ mode: 'off', provider }), site({ provider: undefined })]) {
      const { sink: s, events } = sink();
      await runDecisionSite({ ...opts, sink: s });
      expect(events).toEqual([]);
    }
  });

  it('carries summaries only (K13): no digest, question or raw answer', async () => {
    const { sink: s, events } = sink();
    const tracker = new DecisionRecordTracker(2000);
    const { provider } = stubProvider(() => okResult(0.99));
    await runDecisionSite(
      site({
        mode: 'shadow',
        provider,
        sink: s,
        summarize,
        tracker,
        digest: { kind: 'text', value: 'SECRET-DIGEST' },
      }),
    );
    await tracker.drain();
    const text = JSON.stringify(events);
    expect(text).not.toContain('SECRET-DIGEST');
    expect(text).not.toContain('Is it?');
    expect(text).not.toContain('probabilities');
    // Every emitted body fits the AgentEvent variant core completes it into.
    const _typed: Array<Omit<Extract<AgentEvent, { type: 'decision' }>, 'type' | 'personalityId'>> =
      events;
    expect(_typed).toHaveLength(1);
  });
});
