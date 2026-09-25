// The tier router over a decision provider (plan/phases/decision-provider-jev.md
// §8.3, D15, R9; §14 Router, Redaction, Breaker and regression contract (b)).
// The shared mode/shadow/failure matrix is in `decision-site.test.ts`; this
// file pins this site's mapping, its budget, its digest and its wiring. The
// turn-setup half (R1, user override, downgrade-only in core) is
// packages/core/src/__tests__/tier-router.test.ts.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DECISIONS_API_KEY_REF,
  type DecisionsConfig,
  resolveDecisionsConfig,
} from '@ethosagent/config';
import { createTypesafeDecisionProvider } from '@ethosagent/decision-typesafe';
import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  SecretsResolver,
} from '@ethosagent/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDecisionProvider } from '../decision-provider';
import {
  createDecisionTierRouter,
  ROUTER_QUESTION_ID,
  routerVerdictFrom,
} from '../decision-router';
import type { DecisionCallRecord } from '../decision-site';
import { createAgentLoop, type WiringConfig } from '../index';

vi.mock('@ethosagent/decision-typesafe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/decision-typesafe')>();
  return {
    ...actual,
    createTypesafeDecisionProvider: vi.fn(actual.createTypesafeDecisionProvider),
  };
});

const factory = vi.mocked(createTypesafeDecisionProvider);

beforeEach(() => {
  factory.mockClear();
});

const T = 0.8;

function answers(choice: string, confidence: number) {
  return {
    [ROUTER_QUESTION_ID]: {
      type: 'choice' as const,
      choice,
      probabilities: { [choice]: confidence },
      confidence,
    },
  };
}

function ok(choice: string, confidence: number): DecisionResult {
  return {
    ok: true,
    answers: answers(choice, confidence),
    model: 'jev-1.13.0',
    usage: { inputTokens: 10, outputTokens: 0 },
  };
}

function provider(
  respond: (req: DecisionRequest) => DecisionResult | Promise<DecisionResult>,
  calibrated = true,
) {
  const requests: DecisionRequest[] = [];
  const decide = vi.fn(async (req: DecisionRequest) => {
    requests.push(req);
    return respond(req);
  });
  const p: DecisionProvider = { name: 'typesafe', calibrated, decide };
  return { provider: p, decide, requests };
}

function recorder() {
  const records: DecisionCallRecord[] = [];
  return { recorder: { recordDecisionCall: (r: DecisionCallRecord) => records.push(r) }, records };
}

describe('routerVerdictFrom — the §8.3 gate', () => {
  it('trivial at or above T_trivial → trivial; below → null', () => {
    expect(routerVerdictFrom(answers('trivial', T), T)).toBe('trivial');
    expect(routerVerdictFrom(answers('trivial', 0.95), T)).toBe('trivial');
    expect(routerVerdictFrom(answers('trivial', 0.79), T)).toBeNull();
  });

  it("a 'default' answer is never a verdict, at any confidence", () => {
    expect(routerVerdictFrom(answers('default', 0.99), T)).toBeNull();
  });

  it('an off-list choice (deep, dreaming) → null', () => {
    expect(routerVerdictFrom(answers('deep', 0.99), T)).toBeNull();
    expect(routerVerdictFrom(answers('dreaming', 0.99), T)).toBeNull();
  });

  it('a missing threshold never passes', () => {
    expect(routerVerdictFrom(answers('trivial', 1), undefined)).toBeNull();
  });
});

describe('createDecisionTierRouter — on', () => {
  it('a confident trivial → trivial; the call carries the site budget and the turn signal', async () => {
    const { provider: p, requests } = provider(() => ok('trivial', 0.9));
    const { recorder: r, records } = recorder();
    const signal = new AbortController().signal;
    const router = createDecisionTierRouter({
      decisions: p,
      mode: 'on',
      threshold: T,
      timeoutMs: 500,
      recorder: r,
    });
    expect(await router({ message: 'thanks!', signal })).toBe('trivial');
    expect(requests[0]?.timeoutMs).toBe(500);
    expect(requests[0]?.signal).toBe(signal);
    expect(requests[0]?.state).toBe('thanks!');
    // Router latency per turn is visible (M4 acceptance): the per-call record.
    expect(records[0]).toMatchObject({ site: 'router', mode: 'on', acted: true, outcome: 'ok' });
    expect(typeof records[0]?.latencyMs).toBe('number');
  });

  it("'default', below-threshold, uncalibrated and failed answers → null", async () => {
    const cases: Array<[DecisionProvider, string]> = [
      [provider(() => ok('default', 0.99)).provider, 'default answer'],
      [provider(() => ok('trivial', 0.5)).provider, 'below threshold'],
      [provider(() => ok('trivial', 0.99), false).provider, 'calibrated: false'],
      [
        provider(() => ({ ok: false, code: 'unavailable', message: 'down' })).provider,
        'provider failure',
      ],
      [
        provider(() => {
          throw new Error('boom');
        }).provider,
        'provider throws',
      ],
    ];
    for (const [p, label] of cases) {
      const router = createDecisionTierRouter({
        decisions: p,
        mode: 'on',
        threshold: T,
        timeoutMs: 500,
      });
      expect(await router({ message: 'hi' }), label).toBeNull();
    }
  });
});

describe('createDecisionTierRouter — off and shadow', () => {
  it('R7(b): router `off` with a provider configured never calls decide()', async () => {
    const { provider: p, decide } = provider(() => ok('trivial', 0.99));
    const router = createDecisionTierRouter({
      decisions: p,
      mode: 'off',
      threshold: T,
      timeoutMs: 500,
    });
    expect(await router({ message: 'thanks!' })).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it('shadow returns null without waiting for the provider, and records its reading later', async () => {
    let settle: (r: DecisionResult) => void = () => {};
    const { provider: p } = provider(
      () =>
        new Promise<DecisionResult>((resolve) => {
          settle = resolve;
        }),
    );
    const { recorder: r, records } = recorder();
    const router = createDecisionTierRouter({
      decisions: p,
      mode: 'shadow',
      threshold: T,
      timeoutMs: 500,
      recorder: r,
    });
    expect(await router({ message: 'thanks!' })).toBeNull();
    expect(records).toHaveLength(0);
    settle(ok('trivial', 0.97));
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]).toMatchObject({
      site: 'router',
      mode: 'shadow',
      jevVerdict: 'trivial',
      todayVerdict: null,
      disagreed: true,
    });
  });

  it("shadow carries the turn's traceId onto the record", async () => {
    const { provider: p } = provider(() => ok('trivial', 0.97));
    const { recorder: r, records } = recorder();
    const router = createDecisionTierRouter({
      decisions: p,
      mode: 'shadow',
      threshold: T,
      timeoutMs: 500,
      recorder: r,
    });
    await router({ message: 'thanks!', traceId: 'trace-9' });
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]?.traceId).toBe('trace-9');
  });
});

describe('the router budget (R9)', () => {
  it('the default budget is 500 ms, and decisions.timeouts.router overrides it', () => {
    const base: DecisionsConfig = { provider: 'typesafe', sites: { router: 'shadow' } };
    expect(resolveDecisionsConfig(base).sites.router.timeoutMs).toBe(500);
    expect(
      resolveDecisionsConfig({ ...base, timeouts: { router: 40 } }).sites.router.timeoutMs,
    ).toBe(40);
  });

  it('a provider that never answers is abandoned at the 500 ms budget → no routing', async () => {
    const hanging = createTypesafeDecisionProvider({ apiKey: 'k', fetch: hang });
    const { recorder: r, records } = recorder();
    const router = createDecisionTierRouter({
      decisions: hanging,
      mode: 'on',
      threshold: T,
      timeoutMs: resolveDecisionsConfig({ provider: 'typesafe' }).sites.router.timeoutMs,
      recorder: r,
    });
    const started = Date.now();
    expect(await router({ message: 'thanks!' })).toBeNull();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(1500);
    expect(records[0]).toMatchObject({ outcome: 'timeout', acted: false });
  });

  it('an overridden budget is the one the call is abandoned at', async () => {
    const hanging = createTypesafeDecisionProvider({ apiKey: 'k', fetch: hang });
    const router = createDecisionTierRouter({
      decisions: hanging,
      mode: 'on',
      threshold: T,
      timeoutMs: resolveDecisionsConfig({ provider: 'typesafe', timeouts: { router: 30 } }).sites
        .router.timeoutMs,
    });
    const started = Date.now();
    expect(await router({ message: 'thanks!' })).toBeNull();
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('router timeouts never advance the breaker built by buildDecisionProvider', async () => {
    const actual = await vi.importActual<typeof import('@ethosagent/decision-typesafe')>(
      '@ethosagent/decision-typesafe',
    );
    let requests = 0;
    factory.mockImplementationOnce((o) =>
      actual.createTypesafeDecisionProvider({
        ...o,
        fetch: (url, init) => {
          requests++;
          return hang(url, init);
        },
      }),
    );
    const decisions = resolveDecisionsConfig({
      provider: 'typesafe',
      sites: { router: 'on' },
      thresholds: { router: T },
      timeouts: { router: 20 },
    });
    const breakerEvents: unknown[] = [];
    const built = await buildDecisionProvider({
      decisions,
      sites: ['router'],
      secrets: keyed(),
      observability: { recordDecisionBreaker: (e) => breakerEvents.push(e) },
    });
    // The provider's timeout-counting yardstick is `decisions.timeoutMs` (2000).
    expect(factory.mock.calls[0]?.[0].timeoutMs).toBe(2000);
    const { recorder: r, records } = recorder();
    const router = createDecisionTierRouter({
      decisions: built,
      mode: decisions.sites.router.effective,
      threshold: decisions.thresholds.router,
      timeoutMs: decisions.sites.router.timeoutMs,
      recorder: r,
    });
    // Three counted timeouts would open the breaker; five router timeouts do not.
    for (let i = 0; i < 5; i++) expect(await router({ message: 'thanks!' })).toBeNull();
    expect(requests).toBe(5);
    expect(records.map((x) => x.outcome)).toEqual(Array(5).fill('timeout'));
    expect(breakerEvents).toEqual([]);
  });
});

describe('redaction (R2) — the router digest', () => {
  it('a key pasted in the user message reaches the provider redacted', async () => {
    const KEY = `sk-proj-${'Z9'.repeat(24)}`;
    for (const mode of ['on', 'shadow'] as const) {
      const { provider: p, requests } = provider(() => ok('trivial', 0.97));
      await createDecisionTierRouter({
        decisions: p,
        mode,
        threshold: T,
        timeoutMs: 500,
      })({ message: `here is my key ${KEY}, is that ok?` });
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      const sent = JSON.stringify(requests[0]);
      expect(sent).not.toContain(KEY);
      expect(sent).toContain('[REDACTED:openai-key]');
    }
  });
});

describe('createAgentLoop — the tier router', () => {
  let home: string;
  let dataDir: string;
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ethos-decision-router-'));
    dataDir = join(home, '.ethos');
    mkdirSync(dataDir, { recursive: true });
    for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
    process.env.HOME = home;
    process.env.ETHOS_STATE_DIR = dataDir;
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  /** Offline provider: nothing here sends a completion. */
  function config(extra: Partial<WiringConfig> = {}): WiringConfig {
    return {
      provider: 'ollama',
      model: 'offline-test',
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'sk-dummy',
      secretsResolver: keyed(),
      ...extra,
    };
  }

  function build(cfg: WiringConfig) {
    return createAgentLoop(cfg, { dataDir, workingDir: home, profile: 'cli', disableDocker: true });
  }

  function tierRouterOf(loop: unknown): unknown {
    // biome-ignore lint/complexity/useLiteralKeys: `tierRouter` is private; bracket-string is the TS escape hatch for test access
    return (loop as Record<string, unknown>)['tierRouter'];
  }

  it('no decisions.* keys → no tierRouter and no provider (R7)', async () => {
    const result = await build(config());
    try {
      expect(tierRouterOf(result.loop)).toBeUndefined();
      expect(factory).not.toHaveBeenCalled();
    } finally {
      await result.dispose();
    }
  }, 60_000);

  it('provider set, router off (approver shadow) → no tierRouter', async () => {
    const result = await build(
      config({ decisions: { provider: 'typesafe', sites: { approver: 'shadow' } } }),
    );
    try {
      expect(tierRouterOf(result.loop)).toBeUndefined();
      expect(factory).toHaveBeenCalledTimes(1);
    } finally {
      await result.dispose();
    }
  }, 60_000);

  it('R8 teardown: dispose() waits for a shadow answer still in flight', async () => {
    let settle: (r: DecisionResult) => void = () => {};
    const decide = vi.fn(
      () =>
        new Promise<DecisionResult>((resolve) => {
          settle = resolve;
        }),
    );
    factory.mockImplementationOnce(() => ({ name: 'typesafe', calibrated: true, decide }));
    const result = await build(
      config({ decisions: { provider: 'typesafe', sites: { router: 'shadow' } } }),
    );
    const router = tierRouterOf(result.loop) as (input: {
      message: string;
    }) => Promise<'trivial' | null>;
    expect(await router({ message: 'thanks!' })).toBeNull();
    expect(decide).toHaveBeenCalledTimes(1);

    let disposed = false;
    const disposal = result.dispose().then(() => {
      disposed = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(disposed).toBe(false);
    settle(ok('trivial', 0.97));
    await disposal;
    expect(disposed).toBe(true);
  }, 60_000);

  it('router shadow alone → ONE provider and a tierRouter on the loop', async () => {
    const result = await build(
      config({ decisions: { provider: 'typesafe', sites: { router: 'shadow' } } }),
    );
    try {
      expect(factory).toHaveBeenCalledTimes(1);
      expect(typeof tierRouterOf(result.loop)).toBe('function');
    } finally {
      await result.dispose();
    }
  }, 60_000);
});

function keyed(): SecretsResolver {
  const values: Record<string, string> = { [DECISIONS_API_KEY_REF]: 'ts-live-key' };
  return {
    get: async (ref) => values[ref] ?? null,
    set: async () => {},
    delete: async () => {},
    list: async () => Object.keys(values),
  };
}

/** Never answers; rejects only when the request's signal aborts, like real fetch. */
function hang(_url: string, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init.signal;
    const fail = () => reject(new DOMException('This operation was aborted', 'AbortError'));
    if (signal?.aborted) fail();
    signal?.addEventListener('abort', fail, { once: true });
  });
}
