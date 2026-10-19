// plan background-usage-accounting §5.4 — which provider each wiring site is
// handed, and what the meter itself guarantees. The table cases drive the REAL
// composition root (`createAgentLoop`) and capture the provider each site was
// constructed with at its factory seam; nothing makes a model call. The
// no-double-count invariant itself is `./usage-no-double-count.test.ts`.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultLLMProviderRegistry, isMeteredProvider, withUsageScope } from '@ethosagent/core';
import { MemoryCaptureRunner } from '@ethosagent/memory-capture';
import type { DecisionResult, LLMProvider, UsageRecord, UsageSourceKind } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildKanbanDecomposerProvider } from '../compose-tools';
import { createAgentLoop, type WiringConfig } from '../index';
import { createUsageMeter } from '../usage-meter';
import { scriptedProvider, usageChunk } from './helpers/usage-test-kit';

const seen = vi.hoisted(() => ({
  vision: undefined as ((model: string) => unknown) | undefined,
  web: undefined as ((model: string) => unknown) | undefined,
  classifier: undefined as unknown,
  judge: undefined as unknown,
  fork: undefined as unknown,
  consolidation: undefined as unknown,
}));

vi.mock('@ethosagent/tools-vision', async (importOriginal) => {
  const m = await importOriginal<typeof import('@ethosagent/tools-vision')>();
  return {
    ...m,
    createVisionTools: (opts: Parameters<typeof m.createVisionTools>[0]) => {
      seen.vision = opts.resolveProvider;
      return m.createVisionTools(opts);
    },
  };
});
vi.mock('@ethosagent/tools-web', async (importOriginal) => {
  const m = await importOriginal<typeof import('@ethosagent/tools-web')>();
  return {
    ...m,
    createWebTools: (opts: Parameters<typeof m.createWebTools>[0]) => {
      seen.web = opts?.resolveProvider;
      return m.createWebTools(opts);
    },
  };
});
vi.mock('@ethosagent/safety-injection', async (importOriginal) => {
  const m = await importOriginal<typeof import('@ethosagent/safety-injection')>();
  return {
    ...m,
    createLLMClassifier: (opts: Parameters<typeof m.createLLMClassifier>[0]) => {
      seen.classifier = opts.llm;
      return m.createLLMClassifier(opts);
    },
  };
});
vi.mock('@ethosagent/goal-runner', async (importOriginal) => {
  const m = await importOriginal<typeof import('@ethosagent/goal-runner')>();
  return {
    ...m,
    createLLMCheckJudge: (opts: Parameters<typeof m.createLLMCheckJudge>[0]) => {
      seen.judge = opts.llm;
      return m.createLLMCheckJudge(opts);
    },
  };
});
vi.mock('@ethosagent/skill-evolver', async (importOriginal) => {
  const m = await importOriginal<typeof import('@ethosagent/skill-evolver')>();
  class CapturingFork extends m.ImprovementFork {
    constructor(opts: ConstructorParameters<typeof m.ImprovementFork>[0]) {
      super(opts);
      seen.fork = opts.runtime.llm;
    }
  }
  return { ...m, ImprovementFork: CapturingFork };
});
vi.mock('@ethosagent/nightly-loop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ethosagent/nightly-loop')>()),
  consolidateMemory: vi.fn(async (_input: unknown, llm: unknown) => {
    seen.consolidation = llm;
    return { memory: '', user: '' };
  }),
}));

let home: string;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-usage-meter-wiring-'));
  for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
  process.env.HOME = home;
});

afterAll(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

function kindOf(provider: unknown): UsageSourceKind | 'unmetered' {
  return isMeteredProvider(provider as LLMProvider)
    ? (provider as { kind: UsageSourceKind }).kind
    : 'unmetered';
}

const stub = () => scriptedProvider([{ type: 'text_delta', text: 'ok' }, usageChunk(3, 2, 0.5)]);

describe('createAgentLoop wires every §5.4 site through the meter', () => {
  it('meters each site with its kind; the main llm and the vision tools stay unmetered', async () => {
    const dataDir = mkdtempSync(join(home, 'data-'));
    mkdirSync(dataDir, { recursive: true });
    process.env.ETHOS_STATE_DIR = dataDir;
    const runners: MemoryCaptureRunner[] = [];
    const original = MemoryCaptureRunner.prototype.registerHook;
    const spy = vi
      .spyOn(MemoryCaptureRunner.prototype, 'registerHook')
      .mockImplementation(function (this: MemoryCaptureRunner, hooks) {
        runners.push(this);
        return original.call(this, hooks);
      });
    const config: WiringConfig = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKey: 'sk-test',
      memoryCapture: { enabled: true },
    };
    const result = await createAgentLoop(config, {
      dataDir,
      workingDir: home,
      disableDocker: true,
    });
    try {
      const runnerOpts = (
        runners[0] as unknown as {
          opts: { llm: LLMProvider; consolidate?: (a: unknown) => Promise<void> };
        }
      ).opts;
      await runnerOpts.consolidate?.({
        scopeId: 'personality:x',
        ctx: {
          scopeId: 'personality:x',
          sessionId: 's',
          sessionKey: 'k',
          platform: 'cli',
          workingDir: '',
        },
      });

      const sites: Array<[string, unknown, UsageSourceKind | 'unmetered']> = [
        ['loop main llm', (result.loop as unknown as { llm: LLMProvider }).llm, 'unmetered'],
        ['vision_analyze (D9)', seen.vision?.(config.model), 'unmetered'],
        ['web_extract summarizer', seen.web?.(config.model), 'tool_llm'],
        ['injection classifier', seen.classifier, 'injection_classifier'],
        ['goal check judge', seen.judge, 'goal_judge'],
        ['improvement fork', seen.fork, 'improvement_fork'],
        ['memory capture', runnerOpts.llm, 'memory_capture'],
        ['inline consolidation', seen.consolidation, 'memory_consolidation'],
      ];
      for (const [site, provider, kind] of sites) {
        expect({ site, kind: kindOf(provider) }).toEqual({ site, kind });
      }
      expect(typeof result.usageMeter.meter).toBe('function');
    } finally {
      spy.mockRestore();
      await result.dispose();
    }
  }, 120_000);

  it('the kanban decomposer is metered as tool_llm with sourceRef kanban_decompose', async () => {
    const rows: UsageRecord[] = [];
    const registry = new DefaultLLMProviderRegistry();
    registry.register('anthropic', () => stub());
    const meter = createUsageMeter({ recorder: { record: (r) => rows.push(r) } });
    const provider = await buildKanbanDecomposerProvider(
      registry,
      {
        provider: 'anthropic',
        model: 'main',
        apiKey: 'k',
        auxiliaryKanbanDecomposer: { model: 'aux' },
      },
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      meter,
    );
    expect(kindOf(provider)).toBe('tool_llm');
    for await (const _ of provider?.complete([], [], {}) ?? []) {
      // drain
    }
    expect(rows.map((r) => [r.kind, r.sourceRef])).toEqual([['tool_llm', 'kanban_decompose']]);
  });
});

describe('createUsageMeter', () => {
  it('fills the build defaults where a row is silent, never over what it says', async () => {
    const rows: UsageRecord[] = [];
    const meter = createUsageMeter({
      recorder: { record: (r) => rows.push(r) },
      defaults: { botKey: 'bot-a' },
    });
    for await (const _ of meter.meter(stub(), 'memory_capture').complete([], [], {})) {
      // drain
    }
    meter.recorder.record({ ...rows[0], botKey: 'bot-b' } as UsageRecord);
    expect(rows.map((r) => r.botKey)).toEqual(['bot-a', 'bot-b']);
    expect(rows[0]).toMatchObject({ kind: 'memory_capture', sourceClass: 'background' });
  });

  it('asks the background gate with the build defaults filled, and records a skip once', async () => {
    const asked: Array<{ kind: string; botKey?: string; personalityId?: string }> = [];
    const blocks: Array<{ code?: string; details?: Record<string, unknown> }> = [];
    const rows: UsageRecord[] = [];
    const meter = createUsageMeter({
      recorder: { record: (r) => rows.push(r) },
      defaults: { botKey: 'bot-a' },
      gate: ({ kind, attribution }) => {
        asked.push({ kind, ...attribution });
        return { decision: 'skip', spentUsd: 1, capUsd: 1 };
      },
      observability: { recordSafetyBlock: (b) => blocks.push(b) },
    });
    const capture = meter.meter(stub(), 'memory_capture', { personalityId: 'p' });
    await expect(
      (async () => {
        for await (const _ of capture.complete([], [], {})) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({ code: 'background_budget' });
    expect(asked).toEqual([{ kind: 'memory_capture', botKey: 'bot-a', personalityId: 'p' }]);
    expect(blocks.map((b) => b.code)).toEqual(['usage.background_skipped']);
    expect(rows).toEqual([]);
    // A turn-utility kind is never gated.
    for await (const _ of meter.meter(stub(), 'tool_llm').complete([], [], {})) {
      // drain
    }
    expect(asked).toHaveLength(1);
  });

  it('fails open: a ledger write that throws is recorded as usage.ledger_write_failed', async () => {
    const blocks: Array<{ code?: string; details?: Record<string, unknown> }> = [];
    const meter = createUsageMeter({
      recorder: {
        record: () => {
          throw new Error('database is locked');
        },
      },
      observability: { recordSafetyBlock: (b) => blocks.push(b) },
    });
    let text = '';
    for await (const c of meter.meter(stub(), 'tool_llm').complete([], [], {})) {
      if (c.type === 'text_delta') text += c.text;
    }
    expect(text).toBe('ok');
    expect(blocks).toEqual([
      {
        code: 'usage.ledger_write_failed',
        cause: 'usage ledger write failed (tool_llm)',
        details: { kind: 'tool_llm', error: 'database is locked' },
      },
    ]);
  });

  it('recordExternal fills ts and class, takes the scope attribution, and charges an open turn scope', async () => {
    const rows: UsageRecord[] = [];
    const charged: number[] = [];
    const meter = createUsageMeter({ recorder: { record: (r) => rows.push(r) } });
    const row = {
      kind: 'decision' as const,
      sourceRef: 'injection',
      provider: 'jev',
      model: 'j1',
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0.25,
      outcome: 'ok' as const,
    };
    await withUsageScope(
      { attribution: { sessionId: 's1', sessionKey: 'k1' }, charge: (usd) => charged.push(usd) },
      async () => meter.recordExternal(row),
    );
    // Background spend is recorded but never charged to a turn (D11).
    await withUsageScope(
      { attribution: { sessionId: 's2' }, charge: (usd) => charged.push(usd) },
      async () => meter.recordExternal({ ...row, kind: 'goal_judge' }),
    );
    expect(rows[0]).toMatchObject({
      kind: 'decision',
      sourceClass: 'turn_utility',
      sessionId: 's1',
      sessionKey: 'k1',
      estimatedCostUsd: 0.25,
    });
    expect(typeof rows[0]?.ts).toBe('string');
    expect(rows[1]).toMatchObject({
      kind: 'goal_judge',
      sourceClass: 'background',
      sessionId: 's2',
    });
    expect(charged).toEqual([0.25]);
  });

  it('meterDecision records an answered decide() as one decision row, and a zero-usage answer as none', async () => {
    const rows: UsageRecord[] = [];
    const meter = createUsageMeter({ recorder: { record: (r) => rows.push(r) } });
    const answer = (inputTokens: number, outputTokens: number): DecisionResult => ({
      ok: true,
      answers: { q: { type: 'boolean', p: 0.9, confidence: 0.9 } },
      model: 'j1',
      usage: { inputTokens, outputTokens },
    });
    const results = [
      answer(0, 0),
      answer(10, 1),
      { ok: false as const, code: 'timeout' as const, message: 't' },
    ];
    const provider = meter.meterDecision({
      name: 'jev',
      calibrated: true,
      decide: async () => results.shift() ?? answer(0, 0),
    });
    expect(provider).toMatchObject({ name: 'jev', calibrated: true });
    for (let i = 0; i < 3; i++) await provider.decide({ state: 's', questions: {} });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'decision',
      sourceClass: 'turn_utility',
      provider: 'jev',
      model: 'j1',
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outcome: 'ok',
    });
  });
});
