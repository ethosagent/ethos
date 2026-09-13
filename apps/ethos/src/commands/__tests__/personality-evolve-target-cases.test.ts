// Part 4, Design §2 — `ethos personality evolve` (path 4) freezes an Expression
// candidate's TARGET cases from its own evidence, because verdict rule (c)
// measures "improved" over them:
//   - auto mode → the prompts the Judge scored 0 in the run it just performed;
//   - user mode → none. No Judge runs, so there is no failure to target, and
//     nothing falls back to recent turns.
//
// `runPersonalityEvolve` is driven for real. Only the edges are stubbed: the
// agent loop and LLM (so the Judge's `EvalRunner` writes its REAL run file into
// InMemoryStorage), the config, the session store's path, the drafter, and the
// y/N prompt.

import { join } from 'node:path';
import { listCandidates, listCases, readCase } from '@ethosagent/learning-inbox';
import type { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { CompletionChunk, LLMProvider, Message } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DATA = '/ethos';
const PID = 'sage';

const shared = vi.hoisted(() => ({
  storage: undefined as unknown as import('@ethosagent/storage-fs').InMemoryStorage,
  store: undefined as unknown as import('@ethosagent/session-sqlite').SQLiteSessionStore,
  loopsBuilt: 0,
}));

// The agent answers `OFF-VOICE` to any prompt containing "bad", and the grader
// scores exactly those responses 0; a prompt containing "boom" throws mid-run,
// which the runner records as an errored task with score 0 and no grade.
const fakeLoop = {
  async *run(prompt: string) {
    if (prompt.includes('boom')) throw new Error('provider exploded');
    yield { type: 'text_delta', text: prompt.includes('bad') ? 'OFF-VOICE' : 'on voice' };
    yield { type: 'done', text: '', turnCount: 1 };
  },
};

function grader(): LLMProvider {
  return {
    name: 'mock',
    model: 'mock',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    complete(messages: Message[]): AsyncIterable<CompletionChunk> {
      const last = messages.at(-1);
      const prompt = typeof last?.content === 'string' ? last.content : '';
      return (async function* () {
        yield { type: 'text_delta', text: prompt.includes('OFF-VOICE') ? '0' : '1' };
        yield { type: 'done', finishReason: 'end_turn' };
      })();
    },
    async countTokens() {
      return 0;
    },
  };
}

vi.mock('../../wiring', () => ({
  getStorage: () => shared.storage,
  getSecretsResolver: async () => ({ get: async () => undefined }),
  createAgentLoop: async () => {
    shared.loopsBuilt++;
    return { loop: fakeLoop, dispose: async () => {} };
  },
  createLLM: async () => grader(),
  // The y/N decision goes through the learning inbox; hand the command a real
  // one over the test's storage, so a rejection is the inbox's own.
  createCliLearningInbox: async () => {
    const { createLearningInbox } = await import('@ethosagent/wiring');
    const { createPersonalityRegistry } = await import('@ethosagent/personalities');
    const reg = await createPersonalityRegistry({
      storage: shared.storage,
      userPersonalitiesDir: DATA,
    });
    await reg.loadFromDirectory(join(DATA, 'personalities'));
    return createLearningInbox({
      storage: shared.storage,
      dataDir: DATA,
      personalities: reg,
      expressions: reg,
      defaultPersonalityId: PID,
    });
  },
}));

vi.mock('../../lib/release-command-runtime', () => ({
  releaseCommandRuntime: async () => {},
}));

vi.mock('../../index', () => ({ unifiedDiff: () => '(diff)' }));

vi.mock('@ethosagent/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/config')>();
  return {
    ...actual,
    ethosDir: () => DATA,
    readConfig: async () => ({ model: 'test-model', provider: 'anthropic' }),
  };
});

// The command opens `<ethosDir>/sessions.db`; hand it the test's in-memory
// store instead, with `close` a no-op so the test can keep reading it.
vi.mock('@ethosagent/session-sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/session-sqlite')>();
  return {
    ...actual,
    SQLiteSessionStore: class {
      constructor() {
        // biome-ignore lint/correctness/noConstructorReturn: hands back the shared store
        return Object.create(shared.store, { close: { value: () => {} } });
      }
    },
  };
});

vi.mock('@ethosagent/skill-evolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/skill-evolver')>();
  return {
    ...actual,
    draftExpressionUpdate: async () => ({ newExpression: 'I speak plainly.\n', rationale: 'r' }),
  };
});

vi.mock('node:readline/promises', () => ({
  createInterface: () => ({ question: async () => 'n', close: () => {} }),
}));

const { runPersonalityEvolve } = await import('../personality-evolve');

const baseSession = {
  platform: 'cli',
  model: 'claude-opus-4-7',
  provider: 'anthropic',
  personalityId: PID,
  workingDir: '/tmp',
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    apiCallCount: 0,
    compactionCount: 0,
  },
};

const T0 = new Date('2026-09-12T00:00:00.000Z').getTime();

async function writePersonality(mode: 'auto' | 'user'): Promise<void> {
  const dir = join(DATA, 'personalities', PID);
  await shared.storage.mkdir(dir);
  await shared.storage.write(
    join(dir, 'config.yaml'),
    `name: Sage\nevolution_approval_mode: ${mode}\nnightly.judge.minInteractions: 1\n`,
  );
  await shared.storage.write(
    join(dir, 'SOUL.md'),
    '# Core\nI am wise.\n\n# Expression\nI speak slowly.\n',
  );
}

// Messages are timestamped with the (faked) clock at append time, so each
// session is written at its own hour — the Judge needs 12h of activity.
async function seed(
  key: string,
  atHour: number,
  turns: Array<[user: string, assistant: string]>,
): Promise<void> {
  vi.setSystemTime(T0 + atHour * 3_600_000);
  const s = await shared.store.createSession({ ...baseSession, key });
  for (const [user, assistant] of turns) {
    await shared.store.appendMessage({ sessionId: s.id, role: 'user', content: user });
    await shared.store.appendMessage({ sessionId: s.id, role: 'assistant', content: assistant });
  }
}

async function promptsOf(caseIds: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of caseIds) {
    out.push((await readCase(shared.storage, DATA, PID, id))?.prompt ?? '?');
  }
  return out;
}

async function onlyCandidate() {
  const candidates = await listCandidates(shared.storage, DATA);
  expect(candidates).toHaveLength(1);
  const [candidate] = candidates;
  expect(candidate).toMatchObject({ kind: 'expression', origin: 'cli', personalityId: PID });
  return candidate;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { SQLiteSessionStore: Real } = await vi.importActual<
    typeof import('@ethosagent/session-sqlite')
  >('@ethosagent/session-sqlite');
  shared.storage = new InMemoryStorage();
  shared.store = new Real(':memory:') as SQLiteSessionStore;
  shared.loopsBuilt = 0;
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  shared.store.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ethos personality evolve — Expression target cases (Design §2)', () => {
  it("auto mode: the candidate's target cases are exactly the Judge's zero-scored prompts, never an unrelated recent turn", async () => {
    await writePersonality('auto');
    await seed('cli:older', 0, [['a perfectly fine request from yesterday', 'ok']]);
    await seed('telegram:1', 13, [
      ['another bad one', 'meh'],
      ['a fine follow-up', 'ok'],
      ['this one hits boom', 'meh'],
    ]);

    await runPersonalityEvolve([PID]);

    expect(shared.loopsBuilt).toBe(1);
    const candidate = await onlyCandidate();
    expect(await promptsOf(candidate?.targetCaseIds ?? [])).toEqual(['another bad one']);
    // The well-scored turns and the errored turn were not frozen on the side.
    expect((await listCases(shared.storage, DATA, PID)).map((c) => c.prompt)).toEqual([
      'another bad one',
    ]);
  });

  it('auto mode: a Judge run with no zero-scored prompts yields no target cases, and no fallback fills them', async () => {
    await writePersonality('auto');
    // The LLM scorer is binary, so the only way a run drafts (alignment below
    // 0.85) with no zero-scored prompt is an errored task pulling the mean down.
    await seed('cli:older', 0, [['a perfectly fine request', 'ok']]);
    await seed('cli:newer', 13, [
      ['another fine request', 'ok'],
      ['this one hits boom', 'meh'],
    ]);

    await runPersonalityEvolve([PID]);

    expect(shared.loopsBuilt).toBe(1);
    const candidate = await onlyCandidate();
    expect(candidate?.targetCaseIds).toEqual([]);
    expect(await listCases(shared.storage, DATA, PID)).toEqual([]);
  });

  it('auto mode: an errored Judge task never becomes a target, even when every score in the run is 0', async () => {
    await writePersonality('auto');
    await seed('cli:older', 0, [['boom goes the first', 'meh']]);
    await seed('cli:newer', 13, [['boom goes the second', 'meh']]);

    await runPersonalityEvolve([PID]);

    const candidate = await onlyCandidate();
    expect(candidate?.targetCaseIds).toEqual([]);
    expect(await listCases(shared.storage, DATA, PID)).toEqual([]);
  });

  it('user mode: no Judge runs, so the candidate carries no target cases and no recent turn is frozen', async () => {
    await writePersonality('user');
    await seed('cli:older', 0, [['a bad question from yesterday', 'meh']]);
    await seed('cli:newer', 13, [['a perfectly fine request', 'ok']]);

    await runPersonalityEvolve([PID]);

    expect(shared.loopsBuilt).toBe(0);
    const candidate = await onlyCandidate();
    expect(candidate?.targetCaseIds).toEqual([]);
    expect(candidate?.status).toBe('rejected');
    expect(await listCases(shared.storage, DATA, PID)).toEqual([]);
  });
});
