// Item 4 (plan openclaw-advisory-fixes): scaffold_personality creates NEW
// personalities only, refusing an existing id however it exists (a user dir,
// a built-in in the registry, the caller itself), and the new toolset must be
// a subset of the caller's own (D13). Every refusal happens before the first
// storage.mkdir, so a refused call leaves storage untouched.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  PersonalityConfig,
  PersonalityRegistry,
  Tool,
  ToolContext,
  ToolRegistry,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createPersonalityDesignTools } from '../index';

const PERSONALITIES = join(homedir(), '.ethos', 'personalities');

function ctx(personalityId: string | undefined): ToolContext {
  return {
    sessionId: 's',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    ...(personalityId !== undefined ? { personalityId } : {}),
  };
}

function toolRegistry(names: string[]): ToolRegistry {
  const tools: Tool[] = names.map((name) => ({
    name,
    description: name,
    capabilities: {},
    schema: { type: 'object', properties: {} },
    execute: async () => ({ ok: true as const, value: 'ok' }),
  }));
  const map = new Map(tools.map((t) => [t.name, t]));
  return {
    register: () => {},
    registerAll: () => {},
    unregister: () => {},
    get: (name) => map.get(name),
    getAvailable: () => tools,
    getForToolset: () => [],
    executeParallel: async () => [],
    toDefinitions: () => [],
  };
}

function personalityRegistry(personalities: PersonalityConfig[]): PersonalityRegistry {
  const map = new Map(personalities.map((p) => [p.id, p]));
  return {
    define: () => {},
    get: (id) => map.get(id),
    list: () => personalities,
    getDefault: () => personalities[0] ?? { id: 'none', name: 'None' },
    setDefault: () => {},
    loadFromDirectory: async () => {},
    remove: () => {},
  };
}

// The designer holds read_file + web_search but NOT terminal, which is
// registered and therefore passes the unknown-tool check.
const DESIGNER: PersonalityConfig = {
  id: 'designer',
  name: 'Designer',
  toolset: ['scaffold_personality', 'read_file', 'web_search'],
};
// A built-in: present in the registry, no directory under ~/.ethos/personalities.
const BUILT_IN: PersonalityConfig = {
  id: 'researcher',
  name: 'Researcher',
  toolset: ['read_file'],
};
// A caller whose toolset is undefined (no toolset.yaml): unbounded, so refused.
const UNBOUNDED: PersonalityConfig = { id: 'unbounded', name: 'Unbounded' };

async function setup() {
  const storage = new InMemoryStorage();
  // An existing user personality the registry has not refreshed yet.
  const userDir = join(PERSONALITIES, 'reviewer');
  await storage.mkdir(userDir);
  await storage.write(join(userDir, 'config.yaml'), 'name: Reviewer\n');
  await storage.write(join(userDir, 'toolset.yaml'), '- read_file\n');
  await storage.write(join(userDir, 'SOUL.md'), '# Reviewer\n');

  const tool = createPersonalityDesignTools({
    toolRegistry: toolRegistry(['scaffold_personality', 'read_file', 'web_search', 'terminal']),
    storage,
    modelCatalog: [],
    skills: [],
    personalityRegistry: personalityRegistry([DESIGNER, BUILT_IN, UNBOUNDED]),
  }).find((t) => t.name === 'scaffold_personality');
  if (!tool) throw new Error('scaffold_personality not registered');

  const mutations = [
    vi.spyOn(storage, 'mkdir'),
    vi.spyOn(storage, 'write'),
    vi.spyOn(storage, 'writeAtomic'),
    vi.spyOn(storage, 'append'),
    vi.spyOn(storage, 'remove'),
    vi.spyOn(storage, 'rename'),
  ];
  return { storage, tool, mutations };
}

/** Every file under the personalities root, path → content. */
async function snapshot(storage: InMemoryStorage): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const e of await storage.listEntries(dir)) {
      const p = join(dir, e.name);
      if (e.isDir) {
        out[`${p}/`] = null;
        await walk(p);
      } else {
        out[p] = await storage.read(p);
      }
    }
  };
  await walk(PERSONALITIES);
  return out;
}

const args = (id: string, toolset: string[] = ['read_file']) => ({
  id,
  soul_md: '# New\n\nI am new.',
  config: { name: 'New' },
  toolset,
});

async function expectRefusedUntouched(
  run: (tool: Tool) => Promise<ToolResult>,
  errorPart: string,
): Promise<void> {
  const { storage, tool, mutations } = await setup();
  const before = await snapshot(storage);

  const result = await run(tool);

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe('input_invalid');
    expect(result.error).toContain(errorPart);
  }
  for (const m of mutations) expect(m).not.toHaveBeenCalled();
  expect(await snapshot(storage)).toEqual(before);
}

describe('scaffold_personality — no overwrite, no escalation', () => {
  it('(a) refuses an existing user personality id', async () => {
    await expectRefusedUntouched(
      (tool) => tool.execute(args('reviewer'), ctx('designer')),
      'already exists',
    );
  });

  it('(b) refuses a built-in id that has no user directory', async () => {
    await expectRefusedUntouched(
      (tool) => tool.execute(args('researcher'), ctx('designer')),
      'already exists',
    );
  });

  it("(c) refuses the caller's own personality id", async () => {
    await expectRefusedUntouched(
      (tool) => tool.execute(args('designer'), ctx('designer')),
      'scaffold creates new personalities only',
    );
  });

  it("(d) writes a new id whose toolset is a subset of the caller's", async () => {
    const { storage, tool } = await setup();
    const result = await tool.execute(args('fresh', ['read_file', 'web_search']), ctx('designer'));

    expect(result.ok).toBe(true);
    expect(await storage.read(join(PERSONALITIES, 'fresh', 'toolset.yaml'))).toBe(
      '- read_file\n- web_search\n',
    );
  });

  it('(e) refuses a new id listing a tool the caller lacks, writing nothing', async () => {
    await expectRefusedUntouched(
      (tool) => tool.execute(args('escalator', ['read_file', 'terminal']), ctx('designer')),
      'does not have terminal',
    );
  });

  it('(f) refuses when the caller personality cannot be resolved', async () => {
    const part = 'scaffold needs the calling personality';
    await expectRefusedUntouched((tool) => tool.execute(args('fresh'), ctx(undefined)), part);
    await expectRefusedUntouched((tool) => tool.execute(args('fresh'), ctx('ghost')), part);
  });

  it('(f) refuses a caller with no explicit toolset rather than reading it as unbounded', async () => {
    await expectRefusedUntouched(
      (tool) => tool.execute(args('fresh'), ctx('unbounded')),
      'scaffold needs the calling personality',
    );
  });
});
