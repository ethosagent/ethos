import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runToolNames } from '@ethosagent/initiative-runner';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { InitiativeLedgerPort, MemoryProvider, SessionStore, Tool } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentLoop, type WiringConfig, type WiringProfile } from '../index';
import {
  buildReadOnlyRegistry,
  defaultInitiativeToolFactories,
  type InitiativeToolFactories,
} from '../initiatives';

// Memory and session factories read no dependency at construction.
const factories = defaultInitiativeToolFactories({
  env: {},
  toolsConfig: () => undefined,
  memory: {} as MemoryProvider,
  session: {} as SessionStore,
});
const ledger = {} as InitiativeLedgerPort;
const personality = { id: 'open', name: 'open' };

function build(
  over: Partial<{ toolset: string[]; factories: InitiativeToolFactories; sourcePaths: string[] }>,
) {
  return buildReadOnlyRegistry({
    personality: { ...personality, ...(over.toolset ? { toolset: over.toolset } : {}) },
    ledger,
    initiativeId: 'i1',
    sourcePaths: over.sourcePaths ?? [],
    factories: over.factories ?? factories,
    storage: new InMemoryStorage(),
    dataDir: '/ethos-state',
  });
}

const PROFILES: WiringProfile[] = ['cli', 'web'];

describe('initiative run registry (L2)', () => {
  let home: string;
  const chat = new Map<string, Tool>();
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'ethos-initiative-always-include-'));
    const dataDir = join(home, '.ethos');
    mkdirSync(join(dataDir, 'personalities', 'open'), { recursive: true });
    writeFileSync(join(dataDir, 'personalities', 'open', 'config.yaml'), 'name: open\n');
    writeFileSync(join(dataDir, 'personalities', 'open', 'SOUL.md'), '# Core\nOpen.\n');
    writeFileSync(join(dataDir, 'personalities', 'open', 'toolset.yaml'), '- read_file\n');
    for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
    process.env.HOME = home;
    process.env.ETHOS_STATE_DIR = dataDir;
    const config: WiringConfig = {
      provider: 'ollama',
      model: 'offline-test',
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'sk-dummy',
      personality: 'open',
      memory: 'markdown',
    };
    for (const profile of PROFILES) {
      const runtime = await createAgentLoop(config, {
        dataDir,
        workingDir: home,
        disableDocker: true,
        profile,
      });
      try {
        // Every registered tool, not the personality-filtered view: alwaysInclude
        // tools bypass the toolset, which is the point of the gate.
        for (const tool of runtime.toolRegistry.getAvailable()) chat.set(tool.name, tool);
      } finally {
        await runtime.dispose();
      }
    }
  }, 240_000);

  afterAll(() => {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('R1 no alwaysInclude tool in a run registry', () => {
    const alwaysInclude = [...chat.values()]
      .filter((t) => t.alwaysInclude === true)
      .map((t) => t.name);
    // The chat registry really carries them (the gate is not blind).
    // (dashboard_save and get_skill are registered by hosts this test does not boot;
    // they are named below regardless.)
    expect(alwaysInclude.some((n) => n.startsWith('render_'))).toBe(true);

    const run = build({});
    const names = run.getAvailable().map((t) => t.name);
    for (const name of [...alwaysInclude, 'dashboard_save', 'get_skill']) {
      expect(names, name).not.toContain(name);
    }
    expect(names.some((n) => n.startsWith('render_'))).toBe(false);
    expect(run.getAvailable().filter((t) => t.alwaysInclude === true)).toEqual([]);
  });

  it('registry names ⊆ runToolNames(toolset)', () => {
    for (const toolset of [undefined, ['read_file', 'web_search', 'write_file', 'terminal'], []]) {
      const run = build(toolset ? { toolset } : {});
      const allowed = new Set(runToolNames(toolset));
      const names = run.getAvailable().map((t) => t.name);
      for (const name of names) expect(allowed.has(name), name).toBe(true);
    }
    const narrow = build({ toolset: ['read_file', 'write_file'] })
      .getAvailable()
      .map((t) => t.name);
    expect(narrow).toContain('read_file');
    expect(narrow).toContain('clarify');
    expect(narrow).not.toContain('write_file');
    expect(narrow).not.toContain('web_search');
  });

  it('sourcePaths become the fs_reach read roots of read_file and search_files', () => {
    const run = build({ sourcePaths: ['/repo/a'] });
    expect(run.get('read_file')?.capabilities.fs_reach).toEqual({ read: ['/repo/a'] });
    expect(run.get('search_files')?.capabilities.fs_reach).toEqual({ read: ['/repo/a'] });
  });

  it('L3 runs on build', () => {
    const bad: InitiativeToolFactories = {
      ...factories,
      read: [
        ...factories.read,
        () => [
          {
            name: 'web_search',
            description: 'bad',
            schema: { type: 'object', properties: {} },
            capabilities: { process: { allowedBinaries: ['sh'] } },
            execute: async () => ({ ok: true, value: '' }),
          },
        ],
      ],
    };
    expect(() => build({ factories: bad })).toThrowError(
      expect.objectContaining({ code: 'INITIATIVE_TOOL_NOT_READ_ONLY' }),
    );
  });
});
