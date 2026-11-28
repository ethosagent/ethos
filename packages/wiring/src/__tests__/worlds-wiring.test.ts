// plan world-model 4.6: `world.enabled` composes the world runtime once, registers the ten
// world_* tools over a port, and pushes the WorldContextInjector; off composes nothing.
// S1: the tools reach the model only for a personality whose toolset.yaml lists them
// (buildPersonalityToolExclude `worldTools`, no alwaysInclude).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DefaultToolRegistry } from '@ethosagent/core';
import { WORLD_TOOL_NAMES } from '@ethosagent/tools-world';
import { compose as composeWorld } from '@ethosagent/tools-world/compose';
import type {
  ContextInjector,
  PersonalityConfig,
  ToolContext,
  WiringContext,
} from '@ethosagent/types';
import { WorldContextInjector, type WorldToolPort } from '@ethosagent/world-service';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgentLoop, type WiringConfig } from '../index';

type Runtime = Awaited<ReturnType<typeof createAgentLoop>>;

function writePersonality(dataDir: string, id: string, toolset: string[] | null): void {
  const dir = join(dataDir, 'personalities', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), `name: ${id}\n`);
  writeFileSync(join(dir, 'SOUL.md'), `# Core\nI am ${id}.\n`);
  if (toolset) writeFileSync(join(dir, 'toolset.yaml'), toolset.map((t) => `- ${t}\n`).join(''));
}

function excludeOf(rt: Runtime, person: PersonalityConfig): string[] {
  const fn = Reflect.get(rt.loop, 'personalityToolExclude') as (p: PersonalityConfig) => string[];
  return fn(person);
}

function injectorsOf(rt: Runtime): ContextInjector[] {
  return Reflect.get(rt.loop, 'injectors') as ContextInjector[];
}

/** Tool names the loop shows the model for this personality. */
function visibleNames(rt: Runtime, id: string): string[] {
  const person = rt.personalities.get(id);
  if (!person) throw new Error(`personality ${id} not loaded`);
  return rt.toolRegistry
    .toDefinitions(person.toolset, { excludeTools: excludeOf(rt, person) })
    .map((d) => d.name);
}

const registered = (registry: DefaultToolRegistry): string[] =>
  registry
    .getAvailable()
    .map((t) => t.name)
    .filter((n) => n.startsWith('world_'))
    .sort();

describe('world runtime wiring', () => {
  let home: string;
  let dataDir: string;
  let off: Runtime;
  let on: Runtime;
  const prevEnv: Record<string, string | undefined> = {};

  async function build(world: WiringConfig['world']): Promise<Runtime> {
    return createAgentLoop(
      {
        provider: 'ollama',
        model: 'offline-test',
        baseUrl: 'http://127.0.0.1:9',
        apiKey: 'sk-dummy',
        personality: 'plain',
        memory: 'markdown',
        ...(world ? { world } : {}),
      },
      { dataDir, workingDir: home, disableDocker: true, profile: 'cli' },
    );
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'ethos-worlds-wiring-'));
    dataDir = join(home, '.ethos');
    writePersonality(dataDir, 'lister', [...WORLD_TOOL_NAMES, 'read_file']);
    writePersonality(dataDir, 'plain', ['read_file']);
    writePersonality(dataDir, 'open', null);
    for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
    process.env.HOME = home;
    process.env.ETHOS_STATE_DIR = dataDir;
    off = await build(undefined);
    on = await build({ enabled: true });
  }, 180_000);

  afterAll(async () => {
    await off?.dispose();
    await on?.dispose();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('world.enabled false → no world tools registered, no injector', () => {
    expect(registered(off.toolRegistry)).toEqual([]);
    expect(injectorsOf(off).some((i) => i instanceof WorldContextInjector)).toBe(false);
    expect(injectorsOf(off).some((i) => i.id === 'world-context')).toBe(false);
  });

  it('world.enabled true registers the ten tools and one injector', () => {
    expect(registered(on.toolRegistry)).toEqual([...WORLD_TOOL_NAMES].sort());
    expect(injectorsOf(on).filter((i) => i instanceof WorldContextInjector)).toHaveLength(1);
  });

  it('tools reach the model only when toolset.yaml lists them', () => {
    const listed = visibleNames(on, 'lister').filter((n) => n.startsWith('world_'));
    expect(listed.sort()).toEqual([...WORLD_TOOL_NAMES].sort());
    expect(visibleNames(on, 'plain').filter((n) => n.startsWith('world_'))).toEqual([]);
    // No toolset.yaml: a personality still does not get graph-writing tools by default.
    expect(visibleNames(on, 'open').filter((n) => n.startsWith('world_'))).toEqual([]);
    // Disabled: nobody sees them, even a personality that lists them.
    expect(visibleNames(off, 'lister').filter((n) => n.startsWith('world_'))).toEqual([]);
  });

  it('world_build estimate reads the personality memory through the composed runtime (5.3)', async () => {
    const dir = join(dataDir, 'personalities', 'lister');
    writeFileSync(join(dir, 'MEMORY.md'), 'Ravi owns billing.\n');
    const tool = on.toolRegistry.getAvailable().find((t) => t.name === 'world_build');
    expect(tool).toBeDefined();
    const ctx: ToolContext = {
      sessionId: 's',
      sessionKey: 'cli:world-build',
      platform: 'cli',
      personalityId: 'lister',
      initiator: 'user',
      roomAudience: 'private',
      workingDir: home,
      currentTurn: 1,
      messageCount: 1,
      abortSignal: new AbortController().signal,
      emit: () => {},
      resultBudgetChars: 80_000,
    };
    const r = await tool?.execute({ action: 'estimate', world: 'private' }, ctx);
    expect(r?.ok).toBe(true);
    expect(r?.ok ? r.value : '').toMatch(/^Will read 1 memory file, 0 private sessions, 0 files\./);
    const shared = await tool?.execute(
      { action: 'estimate', world: 'private' },
      { ...ctx, roomAudience: 'shared' },
    );
    expect(shared?.ok).toBe(false);
  });

  it('tool registry receives a port, never a provider', async () => {
    const query = vi.fn(async () => ({
      entities: [],
      attributes: [],
      edges: [],
      truncated: false,
    }));
    const port: WorldToolPort = Object.freeze({
      visible: vi.fn(async () => []),
      query,
      neighbours: vi.fn(),
      history: vi.fn(),
      writeFacts: vi.fn(),
      closeFact: vi.fn(),
      proposeFacts: vi.fn(),
      requestSchemaChange: vi.fn(),
      importBundle: vi.fn(),
      exportBundle: vi.fn(),
      build: vi.fn(),
    });
    const ctx: WiringContext = {
      storage: {} as never,
      dataDir,
      workingDir: home,
      log: {} as never,
    };
    const { tools } = composeWorld(ctx, { port });
    expect(tools.map((t) => t.name).sort()).toEqual([...WORLD_TOOL_NAMES].sort());
    const tool = tools.find((t) => t.name === 'world_query');
    const toolCtx: ToolContext = {
      sessionId: 's',
      sessionKey: 'cli:world-test',
      platform: 'cli',
      personalityId: 'lister',
      initiator: 'user',
      roomAudience: 'private',
      workingDir: home,
      currentTurn: 1,
      messageCount: 1,
      abortSignal: new AbortController().signal,
      emit: () => {},
      resultBudgetChars: 80_000,
    };
    await tool?.execute({ text: 'ravi' }, toolCtx);
    expect(query).toHaveBeenCalledTimes(1);
    // A non-object argument is refused before the port is touched.
    const refused = await tool?.execute('ravi', toolCtx);
    expect(refused?.ok).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
