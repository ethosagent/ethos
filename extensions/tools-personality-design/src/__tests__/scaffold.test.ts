// scaffold_personality creates NEW personalities only (reach-and-containment
// D3-6). It writes through the compose-time Storage, not the turn's scoped
// storage, so the per-turn write-deny list never sees its writes — these two
// refusals are the only thing stopping a personality holding
// `personality_design` from overwriting its own toolset.yaml.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  PersonalityConfig,
  PersonalityRegistry,
  Tool,
  ToolContext,
  ToolRegistry,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createPersonalityDesignTools } from '../index';

const PERSONALITIES = join(homedir(), '.ethos', 'personalities');

function ctx(personalityId: string): ToolContext {
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
    personalityId,
  };
}

function registry(names: string[]): ToolRegistry {
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

// The caller holds both tools, so the D13 subset guard (no-overwrite.test.ts)
// never fires here and these cases exercise the existence refusals alone.
function personalities(): PersonalityRegistry {
  const architect: PersonalityConfig = {
    id: 'architect',
    name: 'Architect',
    toolset: ['read_file', 'terminal'],
  };
  return {
    define: () => {},
    get: (id) => (id === architect.id ? architect : undefined),
    list: () => [architect],
    getDefault: () => architect,
    setDefault: () => {},
    loadFromDirectory: async () => {},
    remove: () => {},
  };
}

function scaffoldFor(storage: InMemoryStorage): Tool {
  const tool = createPersonalityDesignTools({
    toolRegistry: registry(['read_file', 'terminal']),
    storage,
    modelCatalog: [],
    skills: [],
    personalityRegistry: personalities(),
  }).find((t) => t.name === 'scaffold_personality');
  if (!tool) throw new Error('scaffold_personality not registered');
  return tool;
}

const args = (id: string) => ({
  id,
  soul_md: '# Me\n\nI exist.',
  config: { name: 'Me' },
  toolset: ['read_file', 'terminal'],
});

describe('scaffold_personality — creates new personalities only', () => {
  it('refuses the id of the personality running the turn', async () => {
    const storage = new InMemoryStorage();
    const result = await scaffoldFor(storage).execute(args('architect'), ctx('architect'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('input_invalid');
    expect(result.error).toContain('scaffold creates new personalities only');
    expect(await storage.exists(join(PERSONALITIES, 'architect', 'toolset.yaml'))).toBe(false);
  });

  it('refuses an id whose config.yaml already exists, leaving its files untouched', async () => {
    const storage = new InMemoryStorage();
    const dir = join(PERSONALITIES, 'reviewer');
    await storage.mkdir(dir);
    await storage.write(join(dir, 'config.yaml'), 'name: Reviewer\n');
    await storage.write(join(dir, 'toolset.yaml'), '- read_file\n');

    const result = await scaffoldFor(storage).execute(args('reviewer'), ctx('architect'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('input_invalid');
    expect(result.error).toContain('already exists');
    expect(await storage.read(join(dir, 'toolset.yaml'))).toBe('- read_file\n');
    expect(await storage.read(join(dir, 'config.yaml'))).toBe('name: Reviewer\n');
  });

  it('writes a new id', async () => {
    const storage = new InMemoryStorage();
    const result = await scaffoldFor(storage).execute(args('fresh-one'), ctx('architect'));

    expect(result.ok).toBe(true);
    expect(await storage.read(join(PERSONALITIES, 'fresh-one', 'toolset.yaml'))).toBe(
      '- read_file\n- terminal\n',
    );
  });
});
