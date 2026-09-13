import { DefaultHookRegistry } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  AgentDonePayload,
  LLMProvider,
  MemoryProvider,
  PersonalityConfig,
  PersonalityRegistry,
  SessionStore,
} from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
// Relative on purpose: the learning inbox is injected into this package through
// `LearningSubmitPort`, but the tests submit through the REAL store.
import { listCandidates, readCandidate, submitCandidate } from '../../../learning-inbox/src/store';
import { buildForkContext } from '../fork-context';
import {
  ImprovementFork,
  type ImprovementForkOptions,
  resetImprovementForkCooldowns,
} from '../improvement-fork';
import type { LearningSubmitPort } from '../learning-port';

const DATA_DIR = '/tmp/test-evolver';

function learningPort(storage: InMemoryStorage): LearningSubmitPort {
  return {
    submit: (input) => submitCandidate(storage, DATA_DIR, input),
    has: async (id) => (await readCandidate(storage, DATA_DIR, id)) !== null,
  };
}

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
    undoTurns: async () => 0,
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
        memoryProvider: createMockMemoryProvider(),
        sessionStore: createMockSessionStore([]),
        safety: createTestSafety(),
      },
      personalities: opts.personalities ?? makeRegistry(),
      dataDir: DATA_DIR,
      storage,
      learning: learningPort(storage),
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
        memoryProvider: createMockMemoryProvider(),
        sessionStore: createMockSessionStore([
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'World' },
        ]),
        safety: createTestSafety(),
      },
      personalities: makeRegistry(),
      dataDir: DATA_DIR,
      storage,
      learning: learningPort(storage),
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
        memoryProvider: createMockMemoryProvider(),
        sessionStore: createMockSessionStore([
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'World' },
        ]),
        safety: createTestSafety(),
      },
      personalities: makeRegistry(),
      dataDir: DATA_DIR,
      storage,
      learning: learningPort(storage),
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

  /** An LLM whose first turn calls `skill_propose`, then ends. */
  function skillProposeLLM(): LLMProvider {
    let callCount = 0;
    const usage = {
      type: 'usage' as const,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
      },
    };
    const args = JSON.stringify({ content: '# Auto skill\nDo the thing.', reason: 'Works well' });
    return {
      name: 'test-provider',
      model: 'test-model',
      supportsCaching: false,
      supportsThinking: false,
      maxContextTokens: 100000,
      async *complete() {
        callCount++;
        if (callCount === 1) {
          yield { type: 'tool_use_start' as const, toolCallId: 'tc1', toolName: 'skill_propose' };
          yield { type: 'tool_use_delta' as const, toolCallId: 'tc1', partialJson: args };
          yield { type: 'tool_use_end' as const, toolCallId: 'tc1', inputJson: args };
          yield usage;
          yield { type: 'done' as const, finishReason: 'tool_use' as const };
        } else {
          yield { type: 'text_delta' as const, text: 'Done.' };
          yield usage;
          yield { type: 'done' as const, finishReason: 'end_turn' as const };
        }
      },
      async countTokens() {
        return 100;
      },
    };
  }

  function proposingFork(extra: Partial<ImprovementForkOptions> = {}) {
    const hooks = new DefaultHookRegistry();
    const fork = new ImprovementFork({
      hooks,
      runtime: {
        llm: skillProposeLLM(),
        memoryProvider: createMockMemoryProvider(),
        sessionStore: createMockSessionStore([
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'World' },
        ]),
        safety: createTestSafety(),
      },
      personalities: makeRegistry(),
      dataDir: DATA_DIR,
      storage,
      learning: learningPort(storage),
      ...extra,
    });
    fork.register();
    return { hooks, fork };
  }

  it('submits a fork-origin candidate for the triggering turn (L-T6, path 1: fork)', async () => {
    const proposed: Array<{ candidateId: string; personalityId: string }> = [];
    const targetCalls: Array<{ sessionId: string; personalityId: string }> = [];
    const { hooks } = proposingFork({
      targetCaseIds: async (payload, personalityId) => {
        targetCalls.push({ sessionId: payload.sessionId, personalityId });
        return ['case-turn'];
      },
      onSkillProposed: (candidateId, personalityId) => {
        proposed.push({ candidateId, personalityId });
      },
    });

    await hooks.fireVoid('agent_done', basePayload);

    const candidates = await listCandidates(storage, DATA_DIR);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: 'skill',
      op: 'create',
      origin: 'fork',
      personalityId: 'engineer',
      status: 'pending_replay',
      targetCaseIds: ['case-turn'],
      evidence: { sessionIds: ['sess1'] },
    });
    expect(candidates[0]?.destination).toMatch(/^\/tmp\/test-evolver\/skills\/new-.*\.md$/);
    expect(targetCalls).toEqual([{ sessionId: 'sess1', personalityId: 'engineer' }]);
    expect(proposed).toEqual([{ candidateId: candidates[0]?.id, personalityId: 'engineer' }]);
  });

  it('autoApprove no longer writes live: the proposal is submitted as a candidate instead', async () => {
    // `autoApprove` and `onSkillApplied` are gone from the options. Passed
    // anyway, the way a pre-L-T6 composition root would, they must change nothing.
    const applied: string[] = [];
    const { hooks } = proposingFork({
      autoApprove: () => true,
      onSkillApplied: (id: string) => applied.push(id),
    } as Partial<ImprovementForkOptions>);

    await hooks.fireVoid('agent_done', basePayload);

    expect(applied).toEqual([]);
    const liveFiles = (await storage.list(`${DATA_DIR}/skills`)).filter((f) => f.endsWith('.md'));
    expect(liveFiles).toEqual([]);
    expect(await storage.list(`${DATA_DIR}/skills/.pending/engineer`)).toEqual([]);
    const candidates = await listCandidates(storage, DATA_DIR);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.status).toBe('pending_replay');
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
        memoryProvider: createMockMemoryProvider(),
        sessionStore: createMockSessionStore([
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'World' },
        ]),
        safety: createTestSafety(),
      },
      personalities: makeRegistry(),
      dataDir: DATA_DIR,
      storage,
      learning: learningPort(storage),
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

// ---------------------------------------------------------------------------
// skill_evolution keys → the post-turn fork. Each test counts the fork's LLM
// calls (a fork that does not run makes none) or inspects what they carried.
// ---------------------------------------------------------------------------

describe('ImprovementFork honours skill_evolution', () => {
  type CallOptions = Parameters<LLMProvider['complete']>[2];

  const usage = {
    type: 'usage' as const,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0,
    },
  };

  /** Records each completion's options. With `propose`, the first call invokes `skill_propose`. */
  function recordingLLM(propose?: Record<string, string>) {
    const calls: CallOptions[] = [];
    const llm: LLMProvider = {
      name: 'test-provider',
      model: 'test-model',
      supportsCaching: false,
      supportsThinking: false,
      maxContextTokens: 100000,
      async *complete(...args: Parameters<LLMProvider['complete']>) {
        calls.push(args[2]);
        if (propose && calls.length === 1) {
          const json = JSON.stringify(propose);
          yield { type: 'tool_use_start' as const, toolCallId: 'tc1', toolName: 'skill_propose' };
          yield { type: 'tool_use_delta' as const, toolCallId: 'tc1', partialJson: json };
          yield { type: 'tool_use_end' as const, toolCallId: 'tc1', inputJson: json };
          yield usage;
          yield { type: 'done' as const, finishReason: 'tool_use' as const };
          return;
        }
        yield { type: 'text_delta' as const, text: 'NOTHING.' };
        yield usage;
        yield { type: 'done' as const, finishReason: 'end_turn' as const };
      },
      async countTokens() {
        return 100;
      },
    };
    return { llm, calls };
  }

  function forkFor(
    skillEvolution: PersonalityConfig['skill_evolution'],
    llm: LLMProvider,
    storage: InMemoryStorage,
    now?: () => number,
  ) {
    const hooks = new DefaultHookRegistry();
    new ImprovementFork({
      hooks,
      runtime: {
        llm,
        memoryProvider: createMockMemoryProvider(),
        sessionStore: createMockSessionStore([
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'World' },
        ]),
        safety: createTestSafety(),
      },
      personalities: makeRegistry({ skill_evolution: skillEvolution }),
      dataDir: DATA_DIR,
      storage,
      learning: learningPort(storage),
      now,
    }).register();
    return hooks;
  }

  const turn = (successfulToolCalls: number): AgentDonePayload => ({
    sessionId: 'sess1',
    text: 'Done.',
    turnCount: 1,
    personalityId: 'engineer',
    successfulToolCalls,
    totalToolCalls: successfulToolCalls,
  });

  it('enabled: false — the fork never runs, however many tool calls the turn made', async () => {
    const { llm, calls } = recordingLLM();
    const hooks = forkFor({ enabled: false, min_tool_calls: 0 }, llm, new InMemoryStorage());
    await hooks.fireVoid('agent_done', turn(50));
    expect(calls).toHaveLength(0);
  });

  it('enabled absent — the fork never runs (off by default)', async () => {
    const { llm, calls } = recordingLLM();
    const hooks = forkFor({ min_tool_calls: 0 }, llm, new InMemoryStorage());
    await hooks.fireVoid('agent_done', turn(50));
    expect(calls).toHaveLength(0);
  });

  it('min_tool_calls — a turn below the threshold does not fork; a turn at it does', async () => {
    const { llm, calls } = recordingLLM();
    const hooks = forkFor({ enabled: true, min_tool_calls: 3 }, llm, new InMemoryStorage());

    await hooks.fireVoid('agent_done', turn(2));
    expect(calls).toHaveLength(0);

    await hooks.fireVoid('agent_done', turn(3));
    expect(calls).toHaveLength(1);
  });

  it('min_tool_calls absent — the threshold is 5', async () => {
    const { llm, calls } = recordingLLM();
    const hooks = forkFor({ enabled: true }, llm, new InMemoryStorage());
    await hooks.fireVoid('agent_done', turn(4));
    expect(calls).toHaveLength(0);
    await hooks.fireVoid('agent_done', turn(5));
    expect(calls).toHaveLength(1);
  });

  it('cooldown_minutes — a second draft inside the window is suppressed; one after it runs', async () => {
    let now = 1_000_000_000_000;
    const { llm, calls } = recordingLLM();
    const hooks = forkFor(
      { enabled: true, min_tool_calls: 1, cooldown_minutes: 10 },
      llm,
      new InMemoryStorage(),
      () => now,
    );

    await hooks.fireVoid('agent_done', turn(1));
    expect(calls).toHaveLength(1);

    now += 9 * 60_000; // inside the 10-minute window
    await hooks.fireVoid('agent_done', turn(1));
    expect(calls).toHaveLength(1);

    now += 2 * 60_000; // 11 minutes after the first run — outside it
    await hooks.fireVoid('agent_done', turn(1));
    expect(calls).toHaveLength(2);
  });

  it("model — the fork's LLM calls carry skill_evolution.model as modelOverride", async () => {
    const pinned = recordingLLM();
    await forkFor(
      { enabled: true, min_tool_calls: 1, model: 'cheap-drafter' },
      pinned.llm,
      new InMemoryStorage(),
    ).fireVoid('agent_done', turn(1));
    expect(pinned.calls.length).toBeGreaterThan(0);
    expect(pinned.calls.map((o) => o?.modelOverride)).toEqual(
      pinned.calls.map(() => 'cheap-drafter'),
    );

    const unpinned = recordingLLM();
    await forkFor(
      { enabled: true, min_tool_calls: 1 },
      unpinned.llm,
      new InMemoryStorage(),
    ).fireVoid('agent_done', turn(1));
    expect(unpinned.calls.length).toBeGreaterThan(0);
    expect(unpinned.calls.every((o) => o?.modelOverride === undefined)).toBe(true);
  });

  it('evolve_existing: false — a rewrite proposal is refused while a new skill still drafts', async () => {
    const rewrite = { content: '# Better json', reason: 'Improves it', targetFile: 'json.md' };
    const create = { content: '# New skill', reason: 'Reusable' };

    const refused = new InMemoryStorage();
    await forkFor(
      { enabled: true, min_tool_calls: 1, evolve_existing: false },
      recordingLLM(rewrite).llm,
      refused,
    ).fireVoid('agent_done', turn(1));
    expect(await listCandidates(refused, DATA_DIR)).toEqual([]);

    const created = new InMemoryStorage();
    await forkFor(
      { enabled: true, min_tool_calls: 1, evolve_existing: false },
      recordingLLM(create).llm,
      created,
    ).fireVoid('agent_done', turn(1));
    const [newSkill] = await listCandidates(created, DATA_DIR);
    expect(newSkill).toMatchObject({ op: 'create', origin: 'fork' });

    // Absent keeps today's default: the same rewrite is submitted.
    const allowed = new InMemoryStorage();
    await forkFor(
      { enabled: true, min_tool_calls: 1 },
      recordingLLM(rewrite).llm,
      allowed,
    ).fireVoid('agent_done', turn(1));
    const [rewritten] = await listCandidates(allowed, DATA_DIR);
    expect(rewritten).toMatchObject({ op: 'rewrite', origin: 'fork' });
  });
});
