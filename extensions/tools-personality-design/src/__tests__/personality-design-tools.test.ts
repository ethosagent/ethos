import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  PersonalityConfig,
  PersonalityRegistry,
  Skill,
  Tool,
  ToolContext,
  ToolRegistry,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  createPersonalityDesignTools,
  createTeamDesignTools,
  type ModelCatalogEntry,
} from '../index';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'test-session',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    ...overrides,
  };
}

function makeTool(name: string, overrides: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `${name} description`,
    toolset: 'test',
    capabilities: {},
    schema: { type: 'object', properties: {} },
    execute: async () => ({ ok: true as const, value: 'ok' }),
    ...overrides,
  };
}

function makeToolRegistry(tools: Tool[]): ToolRegistry {
  const map = new Map(tools.map((t) => [t.name, t]));
  return {
    register: () => {},
    registerAll: () => {},
    unregister: () => {},
    get: (name) => map.get(name),
    getAvailable: () => tools,
    getForToolset: (ts) => tools.filter((t) => t.toolset === ts),
    executeParallel: async () => [],
    toDefinitions: () => [],
  };
}

function makePersonalityRegistry(personalities: PersonalityConfig[]): PersonalityRegistry {
  const map = new Map(personalities.map((p) => [p.id, p]));
  return {
    define: () => {},
    get: (id) => map.get(id),
    list: () => personalities,
    getDefault: () => personalities[0] ?? ({ id: 'default', name: 'Default' } as PersonalityConfig),
    setDefault: () => {},
    loadFromDirectory: async () => {},
    remove: () => {},
  };
}

const TEST_MODELS: ModelCatalogEntry[] = [
  {
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    label: 'balanced',
    contextWindow: 200_000,
    default: true,
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-opus-4-7',
    label: 'most capable',
    contextWindow: 200_000,
  },
];

const TEST_SKILLS: Skill[] = [
  {
    qualifiedName: 'ethos/code-review',
    name: 'code-review',
    source: 'ethos',
    filePath: '/skills/code-review.md',
    body: 'Review code for quality and correctness.',
    tags: ['code'],
    required_tools: ['read_file', 'terminal'],
    rawFrontmatter: {},
    dialect: 'agentskills',
    mtimeMs: 0,
  },
];

describe('list_available_tools', () => {
  it('returns all registered tools', async () => {
    const tools = [makeTool('read_file'), makeTool('write_file', { toolset: 'file' })];
    const registry = makeToolRegistry(tools);
    const designTools = createPersonalityDesignTools({
      toolRegistry: registry,
      storage: new InMemoryStorage(),
      modelCatalog: TEST_MODELS,
      skills: TEST_SKILLS,
    });

    const listTool = designTools.find((t) => t.name === 'list_available_tools');
    const result = await listTool?.execute({}, makeCtx());
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.value).toContain('read_file');
      expect(result.value).toContain('write_file');
      expect(result.value).toContain('Available Tools (2)');
    }
  });

  it('handles empty registry', async () => {
    const registry = makeToolRegistry([]);
    const designTools = createPersonalityDesignTools({
      toolRegistry: registry,
      storage: new InMemoryStorage(),
      modelCatalog: TEST_MODELS,
      skills: TEST_SKILLS,
    });

    const listTool = designTools.find((t) => t.name === 'list_available_tools');
    const result = await listTool?.execute({}, makeCtx());
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.value).toContain('No tools');
    }
  });
});

describe('list_available_models', () => {
  it('returns model catalog entries', async () => {
    const designTools = createPersonalityDesignTools({
      toolRegistry: makeToolRegistry([]),
      storage: new InMemoryStorage(),
      modelCatalog: TEST_MODELS,
      skills: TEST_SKILLS,
    });

    const listTool = designTools.find((t) => t.name === 'list_available_models');
    const result = await listTool?.execute({}, makeCtx());
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.value).toContain('claude-sonnet-4-6');
      expect(result.value).toContain('claude-opus-4-7');
      expect(result.value).toContain('**(default)**');
    }
  });
});

describe('list_available_skills', () => {
  it('returns skills with summary', async () => {
    const designTools = createPersonalityDesignTools({
      toolRegistry: makeToolRegistry([]),
      storage: new InMemoryStorage(),
      modelCatalog: TEST_MODELS,
      skills: TEST_SKILLS,
    });

    const listTool = designTools.find((t) => t.name === 'list_available_skills');
    const result = await listTool?.execute({}, makeCtx());
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.value).toContain('code-review');
      expect(result.value).toContain('read_file, terminal');
    }
  });
});

describe('scaffold_personality', () => {
  it('creates personality files with valid input', async () => {
    const storage = new InMemoryStorage();
    const tools = [makeTool('read_file'), makeTool('terminal')];
    const registry = makeToolRegistry(tools);
    const designTools = createPersonalityDesignTools({
      toolRegistry: registry,
      storage,
      modelCatalog: TEST_MODELS,
      skills: TEST_SKILLS,
    });

    const scaffoldTool = designTools.find((t) => t.name === 'scaffold_personality');
    const result = await scaffoldTool?.execute(
      {
        id: 'my-researcher',
        soul_md: '# My Researcher\n\nI research topics.',
        config: {
          name: 'My Researcher',
          description: 'A research personality',
          model: 'claude-sonnet-4-6',
          memoryScope: 'global',
        },
        toolset: ['read_file', 'terminal'],
      },
      makeCtx(),
    );

    expect(result?.ok).toBe(true);

    const ethos = await storage.read(
      `${process.env.HOME ?? '/root'}/.ethos/personalities/my-researcher/SOUL.md`,
    );
    expect(ethos).toContain('# My Researcher');

    const config = await storage.read(
      `${process.env.HOME ?? '/root'}/.ethos/personalities/my-researcher/config.yaml`,
    );
    expect(config).toContain('name: My Researcher');
    expect(config).toContain('model: claude-sonnet-4-6');

    const toolset = await storage.read(
      `${process.env.HOME ?? '/root'}/.ethos/personalities/my-researcher/toolset.yaml`,
    );
    expect(toolset).toContain('- read_file');
    expect(toolset).toContain('- terminal');
  });

  it('rejects invalid kebab-case ID', async () => {
    const storage = new InMemoryStorage();
    const registry = makeToolRegistry([makeTool('read_file')]);
    const designTools = createPersonalityDesignTools({
      toolRegistry: registry,
      storage,
      modelCatalog: TEST_MODELS,
      skills: TEST_SKILLS,
    });

    const scaffoldTool = designTools.find((t) => t.name === 'scaffold_personality');
    const result = await scaffoldTool?.execute(
      {
        id: 'MyBadId',
        soul_md: '# Bad',
        config: { name: 'Bad' },
        toolset: ['read_file'],
      },
      makeCtx(),
    );

    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.error).toContain('kebab-case');
    }
  });

  it('rejects unknown tool names', async () => {
    const storage = new InMemoryStorage();
    const registry = makeToolRegistry([makeTool('read_file')]);
    const designTools = createPersonalityDesignTools({
      toolRegistry: registry,
      storage,
      modelCatalog: TEST_MODELS,
      skills: TEST_SKILLS,
    });

    const scaffoldTool = designTools.find((t) => t.name === 'scaffold_personality');
    const result = await scaffoldTool?.execute(
      {
        id: 'test-p',
        soul_md: '# Test',
        config: { name: 'Test' },
        toolset: ['read_file', 'nonexistent_tool'],
      },
      makeCtx(),
    );

    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.error).toContain('nonexistent_tool');
    }
  });

  it('rejects empty soul_md', async () => {
    const storage = new InMemoryStorage();
    const registry = makeToolRegistry([makeTool('read_file')]);
    const designTools = createPersonalityDesignTools({
      toolRegistry: registry,
      storage,
      modelCatalog: TEST_MODELS,
      skills: TEST_SKILLS,
    });

    const scaffoldTool = designTools.find((t) => t.name === 'scaffold_personality');
    const result = await scaffoldTool?.execute(
      {
        id: 'test-p',
        soul_md: '   ',
        config: { name: 'Test' },
        toolset: ['read_file'],
      },
      makeCtx(),
    );

    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.error).toContain('non-empty');
    }
  });
});

describe('list_personalities', () => {
  it('returns all registered personalities', async () => {
    const personalities: PersonalityConfig[] = [
      {
        id: 'engineer',
        name: 'Engineer',
        description: 'Code agent',
        toolset: ['read_file', 'terminal'],
      },
      {
        id: 'researcher',
        name: 'Researcher',
        description: 'Research agent',
        toolset: ['read_file'],
      },
    ];
    const teamTools = createTeamDesignTools({
      personalityRegistry: makePersonalityRegistry(personalities),
      storage: new InMemoryStorage(),
    });

    const listTool = teamTools.find((t) => t.name === 'list_personalities');
    const result = await listTool?.execute({}, makeCtx());
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.value).toContain('engineer');
      expect(result.value).toContain('researcher');
      expect(result.value).toContain('read_file, terminal');
    }
  });
});

describe('list_team_patterns', () => {
  it('returns curated patterns', async () => {
    const teamTools = createTeamDesignTools({
      personalityRegistry: makePersonalityRegistry([]),
      storage: new InMemoryStorage(),
    });

    const listTool = teamTools.find((t) => t.name === 'list_team_patterns');
    const result = await listTool?.execute({}, makeCtx());
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.value).toContain('engineer-reviewer-pair');
      expect(result.value).toContain('engineering-team');
      expect(result.value).toContain('coordinator');
    }
  });
});

describe('scaffold_team', () => {
  it('creates team YAML with valid input', async () => {
    const storage = new InMemoryStorage();
    const teamTools = createTeamDesignTools({
      personalityRegistry: makePersonalityRegistry([]),
      storage,
    });

    const scaffoldTool = teamTools.find((t) => t.name === 'scaffold_team');
    const result = await scaffoldTool?.execute(
      {
        name: 'my-team',
        description: 'A test team',
        domain_capabilities: ['code', 'review'],
        dispatch_mode: 'coordinator',
        coordinator: 'engineer',
        members: [
          { personality: 'engineer', role: 'coordinator' },
          { personality: 'reviewer', role: 'member' },
        ],
      },
      makeCtx(),
    );

    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.value).toContain('my-team');
    }

    const yaml = await storage.read(`${process.env.HOME ?? '/root'}/.ethos/teams/my-team.yaml`);
    expect(yaml).toContain('name: my-team');
    expect(yaml).toContain('description: A test team');
    expect(yaml).toContain('coordinator: engineer');
    expect(yaml).toContain('personality: engineer');
    expect(yaml).toContain('personality: reviewer');
  });

  it('rejects invalid team name', async () => {
    const storage = new InMemoryStorage();
    const teamTools = createTeamDesignTools({
      personalityRegistry: makePersonalityRegistry([]),
      storage,
    });

    const scaffoldTool = teamTools.find((t) => t.name === 'scaffold_team');
    const result = await scaffoldTool?.execute(
      {
        name: 'bad name!',
        description: 'Bad',
        members: [{ personality: 'x' }],
      },
      makeCtx(),
    );

    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.error).toContain('Invalid team name');
    }
  });

  it('rejects empty members', async () => {
    const storage = new InMemoryStorage();
    const teamTools = createTeamDesignTools({
      personalityRegistry: makePersonalityRegistry([]),
      storage,
    });

    const scaffoldTool = teamTools.find((t) => t.name === 'scaffold_team');
    const result = await scaffoldTool?.execute(
      {
        name: 'valid-name',
        description: 'Test',
        members: [],
      },
      makeCtx(),
    );

    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.error).toContain('non-empty');
    }
  });
});
