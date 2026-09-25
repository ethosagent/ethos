// Per-personality small-window mode.
//
// The startup decision measured ONE personality in ONE directory, so a
// `/personality` switch, or a web/gateway turn for a personality whose
// `fs_reach` workdir holds a large AGENTS.md, ran without small-window mode.
// Pins `createSmallWindowResolver` (small-window-resolver.ts), the core seam
// that applies it per turn (`LoopDeps.smallWindowResolver`,
// packages/core/src/agent-loop/stages/turn-setup.ts + agent-loop/small-window.ts),
// and the build-agent-loop wiring that hands it to the loop.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLoop,
  DefaultHookRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
import { INJECTION_DEFENSE_PRELUDE_COMPACT } from '@ethosagent/safety-injection';
import { FileContextInjector } from '@ethosagent/skills';
import { FsStorage } from '@ethosagent/storage-fs';
import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  PersonalityConfig,
  Storage,
  Tool,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../core/src/__tests__/helpers/test-safety';
import { createAgentLoop, type WiringConfig } from '../index';
import { projectContextFor } from '../project-context-floor';
import { createSmallWindowResolver } from '../small-window-resolver';
import { measureStaticFloor, resolveResultBudgetGate } from '../static-floor';

const WINDOW = 64_000;

let root: string;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ethos-small-window-resolver-'));
  for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
});

afterAll(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function writeAgentsMd(dir: string, chars: number, bumpMtime = false): void {
  const file = join(dir, 'AGENTS.md');
  writeFileSync(file, `# Project\n\n${'rule. '.repeat(Math.ceil(chars / 6))}`);
  if (bumpMtime) {
    const later = new Date(Date.now() + 60_000);
    utimesSync(file, later, later);
  }
}

function project(name: string, agentsMdChars: number): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeAgentsMd(dir, agentsMdChars);
  return dir;
}

const makeTool = (name: string): Tool => ({
  name,
  description: `Test tool ${name}`,
  schema: { type: 'object', properties: {} },
  capabilities: {},
  execute: async () => ({ ok: true, value: name }),
});

/** Counts reads per path, so memoization is observable. */
function countingStorage(): { storage: Storage; reads: Map<string, number> } {
  const inner = new FsStorage();
  const reads = new Map<string, number>();
  const storage = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'read') {
        return async (path: string) => {
          reads.set(path, (reads.get(path) ?? 0) + 1);
          return target.read(path);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { storage, reads };
}

describe('per-personality small-window mode in one process', () => {
  function harness(opts: { dirA: string; dirB: string; callTool?: boolean }) {
    const { storage, reads } = countingStorage();
    const personalities = new DefaultPersonalityRegistry();
    const narrow = { small_window_toolset: 'read_file' };
    const a: PersonalityConfig = { id: 'a', name: 'A', context_engine_options: narrow };
    const b: PersonalityConfig = {
      id: 'b',
      name: 'B',
      context_engine_options: narrow,
      fs_reach: { workdir: opts.dirB },
    };
    personalities.define(a);
    personalities.define(b);
    const tools = new DefaultToolRegistry();
    // Records the per-turn tool-result budget each call is handed.
    const budgets: number[] = [];
    tools.register({
      ...makeTool('read_file'),
      execute: async (_args, ctx) => {
        budgets.push(ctx.resultBudgetChars);
        return { ok: true, value: 'read' };
      },
    });
    tools.register(makeTool('write_file'));
    const injector = new FileContextInjector({ storage, personalities });

    const warnings: string[] = [];
    let floorMeasurements = 0;
    const resolver = createSmallWindowResolver({
      windowTokens: WINDOW,
      model: 'm',
      smallWindowOverlay: { promptBudget: { compactPrelude: true }, historyLimit: 40 },
      // A local runtime: the window-scaled budget engages for every personality.
      resultBudget: (_p, staticFloorTokens) =>
        resolveResultBudgetGate({ windowTokens: WINDOW, staticFloorTokens, localRuntime: true }),
      projectContext: (personality, workdir) =>
        projectContextFor({
          injectors: [injector],
          personality,
          workdir,
          platform: 'cli',
          model: 'm',
        }),
      measureFloor: async (personality, projectContextChars) => {
        floorMeasurements++;
        const defs = tools.toDefinitions(personality.toolset);
        return measureStaticFloor({
          soulChars: 0,
          toolSchemaChars: JSON.stringify(defs).length,
          toolCount: defs.length,
          preludeChars: 3_000,
          projectContextChars,
        });
      },
      logger: { warn: (msg) => warnings.push(msg) },
    });

    const calls: Array<{ system: string; tools: string[] }> = [];
    const llm: LLMProvider = {
      name: 'mock',
      model: 'm',
      maxContextTokens: WINDOW,
      supportsCaching: false,
      supportsThinking: false,
      async *complete(messages, defs: ToolDefinitionLite[], o?: CompletionOptions) {
        calls.push({ system: o?.system ?? '', tools: defs.map((d) => d.name) });
        const last = messages.at(-1);
        const answeringTool =
          Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_result');
        const chunks: CompletionChunk[] =
          opts.callTool && !answeringTool
            ? [
                { type: 'tool_use_start', toolCallId: `t${calls.length}`, toolName: 'read_file' },
                { type: 'tool_use_end', toolCallId: `t${calls.length}`, inputJson: '{}' },
                { type: 'done', finishReason: 'tool_use' },
              ]
            : [
                { type: 'text_delta', text: 'ok' },
                { type: 'done', finishReason: 'end_turn' },
              ];
        for (const c of chunks) yield c;
      },
      async countTokens() {
        return 1;
      },
    };
    const loop = new AgentLoop({
      llm,
      tools,
      personalities,
      hooks: new DefaultHookRegistry(),
      injectors: [injector],
      storage,
      dataDir: join(root, 'state'),
      smallWindowResolver: resolver,
      options: { workingDir: opts.dirA },
      safety: createTestSafety(),
    });
    const turn = async (personalityId: string) => {
      for await (const _ of loop.run('hi', { sessionKey: `cli:${personalityId}`, personalityId })) {
        // drain
      }
      const last = calls.at(-1);
      if (!last) throw new Error('no LLM call');
      return last;
    };
    return { turn, warnings, reads, budgets, measurements: () => floorMeasurements };
  }

  it("B's large-AGENTS.md workdir engages small-window mode for B's turns only", async () => {
    const h = harness({ dirA: project('a-small', 600), dirB: project('b-large', 120_000) });

    const a = await h.turn('a');
    expect(a.system.startsWith(INJECTION_DEFENSE_PRELUDE_COMPACT)).toBe(false);
    expect(a.tools.sort()).toEqual(['read_file', 'write_file']);

    const b = await h.turn('b');
    expect(b.system.startsWith(INJECTION_DEFENSE_PRELUDE_COMPACT)).toBe(true);
    expect(b.tools).toEqual(['read_file']);

    // Back to A in the same process: still off.
    const a2 = await h.turn('a');
    expect(a2.tools.sort()).toEqual(['read_file', 'write_file']);

    // One notice, naming B and the project context that put it there.
    const notices = h.warnings.filter((w) => w.startsWith('small-window mode on'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('personality `b`');
    expect(notices[0]).toContain('project context (AGENTS.md/CLAUDE.md)');
  });

  it('memoizes: no re-measure and no AGENTS.md re-read on later turns when nothing changed', async () => {
    const dirB = project('b-memo', 120_000);
    const h = harness({ dirA: project('a-memo', 600), dirB });
    await h.turn('b');
    const afterFirst = h.measurements();
    const readsAfterFirst = h.reads.get(join(dirB, 'AGENTS.md')) ?? 0;
    expect(afterFirst).toBe(1);
    expect(readsAfterFirst).toBe(1);

    await h.turn('b');
    await h.turn('b');
    expect(h.measurements()).toBe(afterFirst);
    expect(h.reads.get(join(dirB, 'AGENTS.md'))).toBe(readsAfterFirst);
    expect(h.warnings.filter((w) => w.startsWith('small-window mode on'))).toHaveLength(1);
  });

  it('a changed AGENTS.md is re-measured, and a newly engaged personality is announced', async () => {
    const dirA = project('a-grows', 600);
    const h = harness({ dirA, dirB: project('b-grows', 600) });
    const before = await h.turn('a');
    expect(before.tools.sort()).toEqual(['read_file', 'write_file']);
    expect(h.measurements()).toBe(1);

    writeAgentsMd(dirA, 120_000, true);
    const after = await h.turn('a');
    expect(h.measurements()).toBe(2);
    expect(after.system.startsWith(INJECTION_DEFENSE_PRELUDE_COMPACT)).toBe(true);
    expect(after.tools).toEqual(['read_file']);
    const notices = h.warnings.filter((w) => w.startsWith('small-window mode on'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('personality `a`');
  });

  it("each personality's turns get the budget its own static floor leaves room for", async () => {
    const h = harness({
      dirA: project('budget-a', 600),
      dirB: project('budget-b', 120_000),
      callTool: true,
    });
    await h.turn('a');
    await h.turn('b');
    await h.turn('a');
    const [a, b, a2] = h.budgets;
    expect(h.budgets).toHaveLength(3);
    // B's big prefix leaves a smaller compactible region, so a smaller budget.
    expect(b).toBeLessThan(a ?? 0);
    // Back on A in the same process: A's own budget, not B's.
    expect(a2).toBe(a);
    expect(a).toBeLessThanOrEqual(80_000);
  });
});

describe('createSmallWindowResolver — seed', () => {
  it('the startup decision is seeded: no re-measure, no second notice', async () => {
    const personality = { id: 'a', name: 'A' } as PersonalityConfig;
    let measured = 0;
    const warnings: string[] = [];
    const resolver = createSmallWindowResolver({
      windowTokens: WINDOW,
      model: 'm',
      smallWindowOverlay: { historyLimit: 40 },
      resultBudget: () => ({ resultBudgetChars: 80_000 }),
      projectContext: async () => 'X'.repeat(120_000),
      measureFloor: async (_p, chars) => {
        measured++;
        return measureStaticFloor({
          soulChars: 0,
          toolSchemaChars: 0,
          toolCount: 0,
          preludeChars: 0,
          projectContextChars: chars,
        });
      },
      logger: { warn: (m) => warnings.push(m) },
      seed: {
        personality,
        workdir: '/w',
        projectContext: 'X'.repeat(120_000),
        floor: measureStaticFloor({
          soulChars: 0,
          toolSchemaChars: 0,
          toolCount: 0,
          preludeChars: 0,
          projectContextChars: 120_000,
        }),
      },
    });
    expect(await resolver(personality, '/w')).toEqual({
      smallWindow: true,
      historyLimit: 40,
      resultBudgetChars: 80_000,
    });
    expect(measured).toBe(0);
    expect(warnings).toEqual([]);
  });
});

describe('createAgentLoop — a switched-to personality with a big-context workdir', () => {
  it('logs the small-window engagement on its first turn, not at startup', async () => {
    const home = join(root, 'home-switch');
    const dataDir = join(home, '.ethos');
    const bigDir = project('switch-big', 160_000);
    const bDir = join(dataDir, 'personalities', 'bigctx');
    mkdirSync(bDir, { recursive: true });
    writeFileSync(
      join(bDir, 'config.yaml'),
      `name: Big Context\ndescription: test\nfs_reach.workdir: ${bigDir}\n`,
    );
    writeFileSync(join(bDir, 'SOUL.md'), 'I am big context.\n');
    writeFileSync(join(bDir, 'toolset.yaml'), '- read_file\n');
    process.env.HOME = home;
    process.env.ETHOS_STATE_DIR = dataDir;
    const warnings: string[] = [];
    const logger = {
      info: () => {},
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
      debug: () => {},
      // biome-ignore lint/suspicious/noExplicitAny: recursive logger mock
      child: () => logger as any,
    };
    const config: WiringConfig = {
      provider: 'ollama',
      model: 'offline-test',
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'sk-dummy',
      contextWindow: WINDOW,
    };
    const runtime = await createAgentLoop(config, {
      dataDir,
      workingDir: project('switch-small', 0),
      profile: 'cli',
      disableDocker: true,
      logger,
    });
    try {
      expect(warnings.some((w) => w.startsWith('small-window mode on'))).toBe(false);
      // The turn's setup runs the resolver; abort before the (offline) LLM call.
      const abort = new AbortController();
      for await (const event of runtime.loop.run('hi', {
        sessionKey: 'cli:switch',
        personalityId: 'bigctx',
        abortSignal: abort.signal,
      })) {
        if (event.type === 'run_start') abort.abort();
      }
      const notice = warnings.find((w) => w.startsWith('small-window mode on'));
      expect(notice).toContain('personality `bigctx`');
      expect(notice).toContain('project context (AGENTS.md/CLAUDE.md)');
    } finally {
      await runtime.dispose();
    }
  });
});

describe('createAgentLoop — the startup narrowing line', () => {
  it('names the startup personality as the one it describes', async () => {
    const home = join(root, 'home-narrow');
    const dataDir = join(home, '.ethos');
    const pDir = join(dataDir, 'personalities', 'narrowed');
    mkdirSync(pDir, { recursive: true });
    writeFileSync(
      join(pDir, 'config.yaml'),
      'name: Narrowed\ndescription: test\ncontext_engine_options.small_window_toolset: read_file\n',
    );
    writeFileSync(join(pDir, 'SOUL.md'), 'I am narrowed.\n');
    writeFileSync(join(pDir, 'toolset.yaml'), '- read_file\n- write_file\n');
    process.env.HOME = home;
    process.env.ETHOS_STATE_DIR = dataDir;
    const infos: string[] = [];
    const logger = {
      info: (msg: string) => infos.push(msg),
      warn: () => {},
      error: () => {},
      debug: () => {},
      // biome-ignore lint/suspicious/noExplicitAny: recursive logger mock
      child: () => logger as any,
    };
    const runtime = await createAgentLoop(
      {
        provider: 'ollama',
        model: 'offline-test',
        baseUrl: 'http://127.0.0.1:9',
        apiKey: 'sk-dummy',
        // At or below 32k small-window mode is on for every personality.
        contextWindow: 16_000,
        personality: 'narrowed',
      },
      {
        dataDir,
        workingDir: project('narrow-cwd', 0),
        profile: 'cli',
        disableDocker: true,
        logger,
      },
    );
    try {
      const line = infos.find((m) => m.includes('small_window_toolset'));
      expect(line).toContain('startup personality `narrowed`');
      expect(line).toContain('surviving tools: read_file');
      expect(line).toContain('other personalities are decided per turn');
    } finally {
      await runtime.dispose();
    }
  });
});
