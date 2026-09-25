// The tier router over a decision provider (plan/phases/decision-provider-jev.md
// §8.3, D15, R9; §14 Router, Redaction, Breaker and regression contract (b)).
// The shared mode/shadow/failure matrix is in `decision-site.test.ts`; this
// file pins this site's mapping, its budget, its digest and its wiring. The
// turn-setup half (R1, user override, downgrade-only in core) is
// packages/core/src/__tests__/tier-router.test.ts.
// Plan decision-provider-personality §7.1/§11: the mode is the turn
// personality's `decisions.sites.router`, resolved per call; `off` (declared
// or undeclared) returns `null` without touching the provider handle.

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
  PersonalityConfig,
  SecretsResolver,
} from '@ethosagent/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDecisionProviderHandle, type DecisionProviderHandle } from '../decision-provider';
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

/** The operator's global config: provider configured, router threshold set. */
const G = resolveDecisionsConfig({ provider: 'typesafe', thresholds: { router: T } });

/** A handle that answers a fixed provider, counting `get()` calls. */
function fixed(p: DecisionProvider | undefined): DecisionProviderHandle & { gets: number } {
  const h = {
    gets: 0,
    get: async () => {
      h.gets++;
      return p;
    },
  };
  return h;
}

/** A personality whose router site is `mode`; no mode → declares nothing. */
function persona(mode?: 'off' | 'shadow' | 'on', id = 'p'): PersonalityConfig {
  return {
    id,
    name: id,
    ...(mode ? { decisions: { provider: 'typesafe', sites: { router: mode } } } : {}),
  };
}

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
    const router = createDecisionTierRouter({ provider: fixed(p), global: G, recorder: r });
    expect(await router({ message: 'thanks!', personality: persona('on'), signal })).toBe(
      'trivial',
    );
    expect(requests[0]?.timeoutMs).toBe(500);
    expect(requests[0]?.signal).toBe(signal);
    expect(requests[0]?.state).toBe('thanks!');
    // Router latency per turn is visible (M4 acceptance): the per-call record.
    expect(records[0]).toMatchObject({
      site: 'router',
      mode: 'on',
      acted: true,
      outcome: 'ok',
      personalityId: 'p',
    });
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
      const router = createDecisionTierRouter({ provider: fixed(p), global: G });
      expect(await router({ message: 'hi', personality: persona('on') }), label).toBeNull();
    }
  });

  it('R6: `on` without the global threshold runs as shadow (never acts)', async () => {
    const { provider: p } = provider(() => ok('trivial', 0.99));
    const { recorder: r, records } = recorder();
    const router = createDecisionTierRouter({
      provider: fixed(p),
      global: resolveDecisionsConfig({ provider: 'typesafe' }),
      recorder: r,
    });
    expect(await router({ message: 'hi', personality: persona('on') })).toBeNull();
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]?.mode).toBe('shadow');
  });
});

describe('createDecisionTierRouter — off and shadow, per personality', () => {
  it('R7(b): an undeclared, `off`, provider-less or unconfigured personality never touches the handle', async () => {
    const { provider: p, decide } = provider(() => ok('trivial', 0.99));
    const handle = fixed(p);
    const router = createDecisionTierRouter({ provider: handle, global: G });
    const personalities: PersonalityConfig[] = [
      persona(),
      persona('off'),
      { id: 'np', name: 'np', decisions: { sites: { router: 'on' } } },
      { id: 'nc', name: 'nc', decisions: { provider: 'acme', sites: { router: 'on' } } },
    ];
    for (const personality of personalities) {
      expect(await router({ message: 'thanks!', personality })).toBeNull();
    }
    expect(decide).not.toHaveBeenCalled();
    expect(handle.gets).toBe(0);
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
    const router = createDecisionTierRouter({ provider: fixed(p), global: G, recorder: r });
    expect(await router({ message: 'thanks!', personality: persona('shadow') })).toBeNull();
    expect(records).toHaveLength(0);
    settle(ok('trivial', 0.97));
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]).toMatchObject({
      site: 'router',
      mode: 'shadow',
      jevVerdict: 'trivial',
      todayVerdict: null,
      disagreed: true,
      personalityId: 'p',
    });
  });

  it("shadow carries the turn's traceId onto the record", async () => {
    const { provider: p } = provider(() => ok('trivial', 0.97));
    const { recorder: r, records } = recorder();
    const router = createDecisionTierRouter({ provider: fixed(p), global: G, recorder: r });
    await router({ message: 'thanks!', personality: persona('shadow'), traceId: 'trace-9' });
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]?.traceId).toBe('trace-9');
  });

  it('two personalities through one router get their own modes', async () => {
    const { provider: p, decide } = provider(() => ok('trivial', 0.97));
    const { recorder: r, records } = recorder();
    const router = createDecisionTierRouter({ provider: fixed(p), global: G, recorder: r });
    expect(await router({ message: 'a', personality: persona('on', 'fast') })).toBe('trivial');
    expect(await router({ message: 'b', personality: persona(undefined, 'plain') })).toBeNull();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(records.map((x) => x.personalityId)).toEqual(['fast']);
  });
});

describe('the router budget (R9)', () => {
  it('the default budget is 500 ms, and decisions.timeouts.router overrides it', () => {
    const base: DecisionsConfig = { provider: 'typesafe' };
    expect(resolveDecisionsConfig(base).timeouts.router).toBe(500);
    expect(resolveDecisionsConfig({ ...base, timeouts: { router: 40 } }).timeouts.router).toBe(40);
  });

  it('a provider that never answers is abandoned at the 500 ms budget → no routing', async () => {
    const hanging = createTypesafeDecisionProvider({ apiKey: 'k', fetch: hang });
    const { recorder: r, records } = recorder();
    const router = createDecisionTierRouter({ provider: fixed(hanging), global: G, recorder: r });
    const started = Date.now();
    expect(await router({ message: 'thanks!', personality: persona('on') })).toBeNull();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(1500);
    expect(records[0]).toMatchObject({ outcome: 'timeout', acted: false });
  });

  it('an overridden budget is the one the call is abandoned at', async () => {
    const hanging = createTypesafeDecisionProvider({ apiKey: 'k', fetch: hang });
    const router = createDecisionTierRouter({
      provider: fixed(hanging),
      global: resolveDecisionsConfig({
        provider: 'typesafe',
        thresholds: { router: T },
        timeouts: { router: 30 },
      }),
    });
    const started = Date.now();
    expect(await router({ message: 'thanks!', personality: persona('on') })).toBeNull();
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('router timeouts never advance the breaker of the provider handle', async () => {
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
      thresholds: { router: T },
      timeouts: { router: 20 },
    });
    const breakerEvents: unknown[] = [];
    const handle = createDecisionProviderHandle({
      decisions,
      secrets: keyed(),
      observability: { recordDecisionBreaker: (e) => breakerEvents.push(e) },
    });
    const { recorder: r, records } = recorder();
    const router = createDecisionTierRouter({ provider: handle, global: decisions, recorder: r });
    // Three counted timeouts would open the breaker; five router timeouts do not.
    for (let i = 0; i < 5; i++) {
      expect(await router({ message: 'thanks!', personality: persona('on') })).toBeNull();
    }
    // The provider's timeout-counting yardstick is `decisions.timeoutMs` (2000).
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[0].timeoutMs).toBe(2000);
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
      await createDecisionTierRouter({ provider: fixed(p), global: G })({
        message: `here is my key ${KEY}, is that ok?`,
        personality: persona(mode),
      });
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

  type Router = (input: {
    message: string;
    personality: PersonalityConfig;
  }) => Promise<'trivial' | null>;

  function tierRouterOf(loop: unknown): Router | undefined {
    // biome-ignore lint/complexity/useLiteralKeys: `tierRouter` is private; bracket-string is the TS escape hatch for test access
    return (loop as Record<string, unknown>)['tierRouter'] as Router | undefined;
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

  it('provider set → a tierRouter; an undeclared personality builds no provider and gets null', async () => {
    const result = await build(config({ decisions: { provider: 'typesafe' } }));
    try {
      const router = tierRouterOf(result.loop);
      expect(typeof router).toBe('function');
      expect(factory).not.toHaveBeenCalled();
      expect(await router?.({ message: 'thanks!', personality: persona() })).toBeNull();
      expect(factory).not.toHaveBeenCalled();
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
    const result = await build(config({ decisions: { provider: 'typesafe' } }));
    const router = tierRouterOf(result.loop);
    expect(await router?.({ message: 'thanks!', personality: persona('shadow') })).toBeNull();
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

  it('a shadow personality → ONE provider, built on its first call', async () => {
    const result = await build(config({ decisions: { provider: 'typesafe' } }));
    try {
      const router = tierRouterOf(result.loop);
      expect(factory).not.toHaveBeenCalled();
      await router?.({ message: 'a', personality: persona('shadow') });
      await router?.({ message: 'b', personality: persona('shadow') });
      expect(factory).toHaveBeenCalledTimes(1);
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
