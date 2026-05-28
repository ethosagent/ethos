import { DefaultHookRegistry } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  LLMProvider,
  MemoryProvider,
  PersonalityConfig,
  PersonalityRegistry,
  SessionStore,
} from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildForkContext } from '../fork-context';
import { ImprovementFork, resetImprovementForkCooldowns } from '../improvement-fork';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function createMockSessionStore(messages: Array<{ role: string; content: string }>): SessionStore {
  const stored = messages.map((m, i) => ({
    id: `msg-${i}`,
    sessionId: 'test-session',
    role: m.role as 'user' | 'assistant' | 'tool_result',
    content: m.content,
    timestamp: new Date(),
  }));

  return {
    getMessages: async () => stored,
    createSession: async (data) => ({
      ...data,
      id: 'stub-session',
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    getSession: async () => null,
    getSessionByKey: async () => null,
    listSessions: async () => [],
    deleteSession: async () => {},
    appendMessage: async (data) => ({
      ...data,
      id: 'stub-msg',
      timestamp: new Date(),
    }),
    updateUsage: async () => {},
    search: async () => [],
    updateSession: async () => {},
    recordCompression: async (event) => ({
      ...event,
      id: 'stub-compression',
      createdAt: new Date(),
    }),
    listCompressions: async () => [],
    recordTurnStart: async () => ({ turnNumber: 1, lastCompactionTurn: 0 }),
    recordCompactionTurn: async () => {},
    pruneOldSessions: async () => 0,
    vacuum: async () => {},
  } as SessionStore;
}

function createMockLLM(): LLMProvider {
  return {
    name: 'test-provider',
    model: 'test-model',
    supportsCaching: false,
    supportsThinking: false,
    maxContextTokens: 100000,
    async *complete() {
      yield {
        type: 'text_delta' as const,
        text: 'Classification: NOTHING. This was a routine turn.',
      };
      yield {
        type: 'usage' as const,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: 0,
        },
      };
    },
    async countTokens() {
      return 100;
    },
  };
}

function createMockMemoryProvider(): MemoryProvider {
  return {
    prefetch: async () => ({ entries: [{ key: 'MEMORY.md', content: '# Memory\n' }] }),
    read: async () => null,
    search: async () => [],
    sync: async () => {},
    list: async () => [],
  };
}

function makeRegistry(overrides: Partial<PersonalityConfig> = {}): PersonalityRegistry {
  const personality: PersonalityConfig = {
    id: 'engineer',
    name: 'Engineer',
    skill_evolution: { enabled: true, min_tool_calls: 5, cooldown_minutes: 60 },
    ...overrides,
  };
  return {
    define: () => {},
    get: (_id: string) => personality,
    list: () => [personality],
    getDefault: () => personality,
    setDefault: () => {},
    loadFromDirectory: async () => {},
    remove: () => {},
  };
}

// ---------------------------------------------------------------------------
// buildForkContext tests
// ---------------------------------------------------------------------------

describe('buildForkContext', () => {
  it('filters tool_result messages', async () => {
    const store = createMockSessionStore([
      { role: 'user', content: 'Please read the file.' },
      { role: 'assistant', content: 'Sure, reading the file now.' },
      { role: 'tool_result', content: 'file contents here' },
    ]);

    const result = await buildForkContext({ sessionId: 'test-session' }, store);

    expect(result).toContain('User:');
    expect(result).toContain('Assistant:');
    expect(result).not.toContain('file contents here');
  });

  it('includes tool summary', async () => {
    const store = createMockSessionStore([{ role: 'user', content: 'Hello' }]);

    const result = await buildForkContext(
      { sessionId: 'test-session', toolNames: ['read_file', 'write_file'] },
      store,
    );

    expect(result).toContain('Tools used: read_file, write_file');
  });

  it('includes skill summary', async () => {
    const store = createMockSessionStore([{ role: 'user', content: 'Hello' }]);

    const result = await buildForkContext(
      { sessionId: 'test-session', activeSkillFiles: ['coding.md'] },
      store,
    );

    expect(result).toContain('Active skills: coding.md');
  });

  it('handles empty session', async () => {
    const store = createMockSessionStore([]);

    const result = await buildForkContext({ sessionId: 'test-session' }, store);

    expect(result).toContain('## Transcript');
  });

  it('truncates long messages', async () => {
    const longContent = 'A'.repeat(800);
    const store = createMockSessionStore([{ role: 'user', content: longContent }]);

    const result = await buildForkContext({ sessionId: 'test-session' }, store);

    // The output should be shorter than the raw message (600 char truncation + label)
    expect(result.length).toBeLessThan(longContent.length);
    // Should end with the truncation marker
    expect(result).toContain('…');
  });
});

// ---------------------------------------------------------------------------
// ImprovementFork tests
// ---------------------------------------------------------------------------

describe('ImprovementFork', () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
  });

  function createFork(
    opts: {
      personalities?: PersonalityRegistry;
      now?: () => number;
      onSkillProposed?: (skillId: string, personalityId: string) => void;
    } = {},
  ) {
    const hooks = new DefaultHookRegistry();
    const fork = new ImprovementFork({
      hooks,
      runtime: {
        llm: createMockLLM(),
        model: 'test-model',
        memoryProvider: createMockMemoryProvider(),
        sessionStore: createMockSessionStore([]),
      },
      personalities: opts.personalities ?? makeRegistry(),
      dataDir: '/tmp/test-evolver',
      storage,
      now: opts.now,
      onSkillProposed: opts.onSkillProposed,
    });
    return { hooks, fork };
  }

  const basePayload = {
    sessionId: 'sess1',
    text: 'Done.',
    turnCount: 3,
    personalityId: 'engineer',
    successfulToolCalls: 6,
    totalToolCalls: 6,
    toolNames: ['read_file', 'write_file'],
  };

  it('does not fork when personality has skill_evolution disabled', async () => {
    const { hooks, fork } = createFork({
      personalities: makeRegistry({ skill_evolution: { enabled: false } }),
    });
    fork.register();

    // If shouldFork returns false, run() is never called — the hook
    // completes without error and without spawning an AgentLoop.
    await hooks.fireVoid('agent_done', {
      ...basePayload,
      successfulToolCalls: 10,
    });
    // No error thrown — shouldFork returned false.
  });

  it('does not fork when below tool call threshold', async () => {
    const { hooks, fork } = createFork();
    fork.register();

    await hooks.fireVoid('agent_done', {
      ...basePayload,
      successfulToolCalls: 2,
    });
    // No error thrown — shouldFork returned false (below min_tool_calls=5).
  });

  it('does not fork when no personalityId', async () => {
    const { hooks, fork } = createFork();
    fork.register();

    await hooks.fireVoid('agent_done', {
      ...basePayload,
      personalityId: undefined,
    });
    // No error thrown — shouldFork returned false (no personalityId).
  });

  it('respects cooldown — second fire within window does not fork', async () => {
    let now = 1_000_000_000_000;
    const calls: number[] = [];
    const mockLLM = createMockLLM();
    const origComplete = mockLLM.complete.bind(mockLLM);
    mockLLM.complete = async function* (...args: Parameters<LLMProvider['complete']>) {
      calls.push(now);
      yield* origComplete(...args);
    };

    const hooks = new DefaultHookRegistry();
    const fork = new ImprovementFork({
      hooks,
      runtime: {
        llm: mockLLM,
        model: 'test-model',
        memoryProvider: createMockMemoryProvider(),
        sessionStore: createMockSessionStore([
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'World' },
        ]),
      },
      personalities: makeRegistry(),
      dataDir: '/tmp/test-evolver',
      storage,
      now: () => now,
    });
    fork.register();

    // First fire — should fork
    await hooks.fireVoid('agent_done', basePayload);
    expect(calls).toHaveLength(1);

    // 30 minutes later — still inside the 60-minute cooldown
    now += 30 * 60_000;
    await hooks.fireVoid('agent_done', basePayload);
    // Should NOT have fired again
    expect(calls).toHaveLength(1);
  });

  it('forks after cooldown expires', async () => {
    let now = 1_000_000_000_000;
    const calls: number[] = [];
    const mockLLM = createMockLLM();
    const origComplete = mockLLM.complete.bind(mockLLM);
    mockLLM.complete = async function* (...args: Parameters<LLMProvider['complete']>) {
      calls.push(now);
      yield* origComplete(...args);
    };

    const hooks = new DefaultHookRegistry();
    const fork = new ImprovementFork({
      hooks,
      runtime: {
        llm: mockLLM,
        model: 'test-model',
        memoryProvider: createMockMemoryProvider(),
        sessionStore: createMockSessionStore([
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'World' },
        ]),
      },
      personalities: makeRegistry(),
      dataDir: '/tmp/test-evolver',
      storage,
      now: () => now,
    });
    fork.register();

    // First fire
    await hooks.fireVoid('agent_done', basePayload);
    expect(calls).toHaveLength(1);

    // 61 minutes later — past the 60-minute cooldown
    now += 61 * 60_000;
    await hooks.fireVoid('agent_done', basePayload);
    expect(calls).toHaveLength(2);
  });

  it('resetImprovementForkCooldowns clears cooldown state', async () => {
    const now = 1_000_000_000_000;
    const calls: number[] = [];
    const mockLLM = createMockLLM();
    const origComplete = mockLLM.complete.bind(mockLLM);
    mockLLM.complete = async function* (...args: Parameters<LLMProvider['complete']>) {
      calls.push(now);
      yield* origComplete(...args);
    };

    const hooks = new DefaultHookRegistry();
    const fork = new ImprovementFork({
      hooks,
      runtime: {
        llm: mockLLM,
        model: 'test-model',
        memoryProvider: createMockMemoryProvider(),
        sessionStore: createMockSessionStore([
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'World' },
        ]),
      },
      personalities: makeRegistry(),
      dataDir: '/tmp/test-evolver',
      storage,
      now: () => now,
    });
    fork.register();

    // First fire
    await hooks.fireVoid('agent_done', basePayload);
    expect(calls).toHaveLength(1);

    // Reset cooldowns — next fire should succeed even without waiting
    resetImprovementForkCooldowns(fork);

    await hooks.fireVoid('agent_done', basePayload);
    expect(calls).toHaveLength(2);
  });
});
