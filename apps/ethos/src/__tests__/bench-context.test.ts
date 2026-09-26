import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultPersonalityRegistry, DefaultToolRegistry } from '@ethosagent/core';
import { FsStorage } from '@ethosagent/storage-fs';
import type { PersonalityConfig, Tool } from '@ethosagent/types';
import {
  createAgentLoop,
  createProjectContextInjector,
  evaluateToolSchemaBudget,
  measureStaticFloor,
  projectContextAtStartup,
} from '@ethosagent/wiring';
import { describe, expect, it } from 'vitest';
import { measurePersonalityStatic } from '../commands/bench';

const makeTool = (name: string, description = `Test tool ${name}`): Tool => ({
  name,
  description,
  schema: { type: 'object', properties: { path: { type: 'string' } } },
  capabilities: {},
  execute: async () => ({ ok: true, value: name }),
});

const makePersonality = (id: string, toolset?: string[]): PersonalityConfig => ({
  id,
  name: id,
  ...(toolset ? { toolset } : {}),
});

describe('measurePersonalityStatic', () => {
  it('counts SOUL chars and only the tools in the personality toolset', () => {
    const registry = new DefaultToolRegistry();
    registry.register(makeTool('read_file'));
    registry.register(makeTool('write_file'));
    registry.register(makeTool('web_search'));

    const soul = 'I am a reader.';
    const row = measurePersonalityStatic(makePersonality('reader', ['read_file']), soul, registry);

    expect(row.id).toBe('reader');
    expect(row.soulChars).toBe(soul.length);
    expect(row.toolCount).toBe(1);
    const expectedChars = JSON.stringify(registry.toDefinitions(['read_file'])).length;
    expect(row.toolSchemaChars).toBe(expectedChars);
    expect(row.estStaticTokens).toBe(Math.ceil((soul.length + expectedChars) / 4));
  });

  it('an unrestricted toolset sees every registered tool', () => {
    const registry = new DefaultToolRegistry();
    registry.register(makeTool('a'));
    registry.register(makeTool('b'));

    const row = measurePersonalityStatic(makePersonality('open'), '', registry);
    expect(row.toolCount).toBe(2);
    expect(row.soulChars).toBe(0);
    expect(row.toolSchemaChars).toBe(JSON.stringify(registry.toDefinitions(undefined)).length);
  });

  it('a bigger schema costs more estimated tokens than a smaller one', () => {
    const registry = new DefaultToolRegistry();
    registry.register(makeTool('tiny', 'x'));
    registry.register(makeTool('verbose', 'A long description. '.repeat(50)));

    const tiny = measurePersonalityStatic(makePersonality('p1', ['tiny']), '', registry);
    const verbose = measurePersonalityStatic(makePersonality('p2', ['verbose']), '', registry);
    expect(verbose.toolSchemaChars).toBeGreaterThan(tiny.toolSchemaChars);
    expect(verbose.estStaticTokens).toBeGreaterThan(tiny.estStaticTokens);
  });

  it('degrades without a tool registry: toolset name count, zero schema chars', () => {
    const soul = 'soul body';
    const row = measurePersonalityStatic(makePersonality('bare', ['read_file', 'terminal']), soul);
    expect(row.toolCount).toBe(2);
    expect(row.toolSchemaChars).toBe(0);
    expect(row.estStaticTokens).toBe(Math.ceil(soul.length / 4));
  });

  // D8 cross-check — bench and build-agent-loop share ONE static-floor
  // arithmetic: fed the same inputs, `measurePersonalityStatic` reports the
  // exact number `measureStaticFloor` (which build-agent-loop consumes)
  // produces, prelude included.
  it('produces the same static-floor number as the shared wiring helper', () => {
    const registry = new DefaultToolRegistry();
    registry.register(makeTool('read_file'));
    registry.register(makeTool('bash'));

    const soul = 'I am the cross-check personality.';
    const preludeChars = 1_337;
    const row = measurePersonalityStatic(
      makePersonality('xcheck', ['read_file', 'bash']),
      soul,
      registry,
      preludeChars,
    );
    const floor = measureStaticFloor({
      soulChars: soul.length,
      toolSchemaChars: JSON.stringify(registry.toDefinitions(['read_file', 'bash'])).length,
      toolCount: 2,
      preludeChars,
    });
    expect(row.estStaticTokens).toBe(floor.tokens);
    expect(row.toolCount).toBe(floor.toolCount);
  });

  it('adds the project-context column to the total static prefix, same arithmetic as wiring', () => {
    const registry = new DefaultToolRegistry();
    registry.register(makeTool('read_file'));
    const personality = makePersonality('ctx', ['read_file']);
    const without = measurePersonalityStatic(personality, 'soul', registry, 1_000);
    const withContext = measurePersonalityStatic(personality, 'soul', registry, 1_000, 40_000);
    expect(without.projectContextChars).toBe(0);
    expect(withContext.projectContextChars).toBe(40_000);
    expect(withContext.estStaticTokens).toBe(
      measureStaticFloor({
        soulChars: 4,
        toolSchemaChars: withContext.toolSchemaChars,
        toolCount: 1,
        preludeChars: 1_000,
        projectContextChars: 40_000,
      }).tokens,
    );
    expect(withContext.estStaticTokens - without.estStaticTokens).toBe(10_000);
  });

  // The column's number is the block the loop's file-context injector sends
  // for that directory: measured through the same class, the same resolution.
  it('measures the AGENTS.md block a turn launched in the cwd would send', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ethos-bench-project-context-'));
    try {
      writeFileSync(join(dir, 'AGENTS.md'), `# Rules\n\n${'rule. '.repeat(5_000)}`);
      const personalities = new DefaultPersonalityRegistry();
      const injectors = [createProjectContextInjector({ storage: new FsStorage(), personalities })];
      const block = await projectContextAtStartup({
        injectors,
        personality: makePersonality('p'),
        workingDir: dir,
        dataDir: join(dir, '.ethos'),
        platform: 'cli',
        model: 'm',
      });
      expect(block.startsWith('## Project Context')).toBe(true);
      expect(block.length).toBeGreaterThan(30_000);
      const row = measurePersonalityStatic(makePersonality('p'), '', undefined, 0, block.length);
      expect(row.projectContextChars).toBe(block.length);
      expect(row.estStaticTokens).toBe(Math.ceil(block.length / 4));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Lane 3(b) cross-check — the schema-budget warning threshold and the bench
  // measurement agree: for one personality, the chars/tokens the bench table
  // reports ARE the numbers `evaluateToolSchemaBudget` (the startup warning,
  // also wired into `ethos bench context`) divides by the served window.
  it('the schema-budget warning reads the same measurement the bench reports', () => {
    const registry = new DefaultToolRegistry();
    registry.register(makeTool('read_file', 'A long description. '.repeat(400)));
    registry.register(makeTool('bash', 'Another long description. '.repeat(400)));

    const personality = makePersonality('budget-xcheck', ['read_file', 'bash']);
    const row = measurePersonalityStatic(personality, '', registry);
    const verdict = evaluateToolSchemaBudget({
      personalityId: personality.id,
      windowTokens: 8_000,
      toolDefinitions: registry.toDefinitions(personality.toolset),
    });

    expect(verdict.toolSchemaChars).toBe(row.toolSchemaChars);
    expect(verdict.toolSchemaTokens).toBe(Math.ceil(row.toolSchemaChars / 4));
    expect(verdict.share).toBe(verdict.toolSchemaTokens / 8_000);
    // Over the 0.4 default on an 8k window → the warning names the personality.
    expect(verdict.message).toContain('budget-xcheck');
  });
});

// reach-and-containment Part 1 — the §1.1 success metric, against the REAL
// registered tools and the REAL built-in `engineer` (with C8's pinned_tools):
// the first-step payload under on-demand tool loading is at most half of the
// full schema payload. Driven through the production composition root with an
// offline provider and a throwaway HOME / ETHOS_STATE_DIR, so it cannot drift
// silently when a tool's schema grows.
describe('tool_loading_chars — engineer (plan §1.1)', () => {
  it('pinned + tool_search is at most 50% of the full tool-schema payload', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ethos-bench-tool-loading-'));
    const dataDir = join(home, '.ethos');
    mkdirSync(dataDir, { recursive: true });
    const prev = { HOME: process.env.HOME, ETHOS_STATE_DIR: process.env.ETHOS_STATE_DIR };
    process.env.HOME = home;
    process.env.ETHOS_STATE_DIR = dataDir;
    try {
      const runtime = await createAgentLoop(
        {
          provider: 'ollama',
          model: 'offline-test',
          baseUrl: 'http://127.0.0.1:9',
          apiKey: 'sk-dummy',
          personality: 'engineer',
        },
        { dataDir, workingDir: home, profile: 'cli', disableDocker: true },
      );
      try {
        const engineer = runtime.personalities.get('engineer');
        expect(engineer).toBeDefined();
        if (!engineer) return;
        expect(engineer.context_engine_options?.pinned_tools).toBeDefined();
        const row = measurePersonalityStatic(engineer, '', runtime.toolRegistry);
        expect(row.toolCount).toBeGreaterThan(10);
        expect(row.toolLoadingChars).toBeGreaterThan(0);
        expect(row.toolLoadingChars).toBeLessThanOrEqual(0.5 * row.toolSchemaChars);
      } finally {
        await runtime.dispose();
      }
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
