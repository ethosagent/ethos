// Part 4, Design §2 — a nightly candidate's TARGET cases come from its own
// evidence, because verdict rule (c) measures "improved" over them:
//   - nightly Expression → the prompts the Judge scored 0 in its run file;
//   - nightly skills     → the user turns `buildEvidenceDigest` quoted.
// A candidate measured on arbitrary recent turns could be promoted for doing
// better on prompts unrelated to the failure it was drafted to fix.
//
// The Judge run file here is written by the REAL `EvalRunner` through
// `scorePersonality`, so the parser is pinned to the format actually on disk.

import { join } from 'node:path';
import type { AgentLoop } from '@ethosagent/core';
import { EvalRunner } from '@ethosagent/eval-harness';
import {
  LEARNING_EXCLUDED_KEY_PREFIXES,
  listCases,
  readCandidate,
  readCase,
} from '@ethosagent/learning-inbox';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { scorePersonality } from '@ethosagent/personality-judge';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { proposeSkillFromEvidence } from '@ethosagent/skill-evolver';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { CompletionChunk, LLMProvider, Message } from '@ethosagent/types';
import { learningSubmitPort, submitExpressionCandidate } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildEvidenceDigest,
  freezeTargetTurnCases,
  gatherRecentUserPrompts,
  judgeZeroScoredTurns,
} from '../personality-evolve';

const DATA = '/ethos';
const PID = 'sage';
const RUN_FILE = join(DATA, 'personalities', PID, '.judge-history', 'runs', '1.jsonl');

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

function textLLM(reply: (prompt: string) => string): LLMProvider {
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
        yield { type: 'text_delta', text: reply(prompt) };
        yield { type: 'done', finishReason: 'end_turn' };
      })();
    },
    async countTokens() {
      return 0;
    },
  };
}

// The agent answers `OFF-VOICE` to any prompt containing "bad", and the grader
// scores exactly those responses 0; a prompt containing "boom" throws mid-run.
const fakeLoop = {
  async *run(prompt: string) {
    if (prompt.includes('boom')) throw new Error('provider exploded');
    yield { type: 'text_delta', text: prompt.includes('bad') ? 'OFF-VOICE' : 'on voice' };
    yield { type: 'done', text: '', turnCount: 1 };
  },
} as unknown as AgentLoop;
const grader = textLLM((instruction) => (instruction.includes('OFF-VOICE') ? '0' : '1'));

let storage: InMemoryStorage;
let reg: FilePersonalityRegistry;
let store: SQLiteSessionStore;
let ctx: { storage: InMemoryStorage; dataDir: string; personalities: FilePersonalityRegistry };

beforeEach(async () => {
  storage = new InMemoryStorage();
  const dir = join(DATA, 'personalities', PID);
  await storage.mkdir(dir);
  await storage.write(join(dir, 'config.yaml'), 'name: Sage\n');
  await storage.write(
    join(dir, 'SOUL.md'),
    '# Core\nI am wise.\n\n# Expression\nI speak slowly.\n',
  );
  reg = new FilePersonalityRegistry(storage, DATA);
  await reg.loadFromDirectory(join(DATA, 'personalities'));
  store = new SQLiteSessionStore(':memory:');
  ctx = { storage, dataDir: DATA, personalities: reg };
});

afterEach(() => {
  store.close();
});

async function seed(key: string, turns: Array<[user: string, assistant: string]>): Promise<void> {
  const s = await store.createSession({ ...baseSession, key });
  for (const [user, assistant] of turns) {
    await store.appendMessage({ sessionId: s.id, role: 'user', content: user });
    await store.appendMessage({ sessionId: s.id, role: 'assistant', content: assistant });
  }
}

/** Run the Judge the way `nightly.ts` `scoreAlignment` does, into `RUN_FILE`. */
async function judgeRun(): Promise<Awaited<ReturnType<typeof gatherRecentUserPrompts>>> {
  const recent = await gatherRecentUserPrompts(store, PID);
  await storage.mkdir(join(DATA, 'personalities', PID, '.judge-history', 'runs'));
  const runner = new EvalRunner(fakeLoop, {
    concurrency: 4,
    outputPath: RUN_FILE,
    defaultScorer: 'llm',
    llmProvider: grader,
    storage,
  });
  const outcome = await scorePersonality({
    personalityId: PID,
    core: 'I am wise.',
    expression: 'I speak slowly.',
    recentPrompts: recent.prompts,
    windowStart: recent.windowStart,
    windowEnd: recent.windowEnd,
    elapsedHours: recent.elapsedHours,
    priorLowStreak: 0,
    runner,
    activation: { minInteractions: 1, minElapsedHours: 0 },
  });
  expect(outcome.kind).toBe('scored');
  return recent;
}

async function targetPrompts(caseIds: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of caseIds) out.push((await readCase(storage, DATA, PID, id))?.prompt ?? '?');
  return out;
}

describe('nightly Expression target cases (Design §2)', () => {
  it("a nightly Expression candidate's target cases are exactly the Judge's zero-scored prompts, never an unrelated recent turn", async () => {
    await seed('cli:older', [['a bad question from yesterday', 'meh']]);
    await seed('telegram:1', [
      ['a perfectly fine request', 'ok'],
      ['another bad one', 'meh'],
      ['this one hits boom', 'meh'],
    ]);
    const recent = await judgeRun();

    const targetCaseIds = await freezeTargetTurnCases(
      ctx,
      PID,
      judgeZeroScoredTurns(await storage.read(RUN_FILE), recent.turns),
    );
    const candidate = await submitExpressionCandidate(ctx, {
      personalityId: PID,
      origin: 'nightly',
      newExpression: 'I speak plainly.\n',
      rationale: 'r',
      evidenceRef: 'nightly:0.50@w',
      targetCaseIds,
    });

    const stored = await readCandidate(storage, DATA, candidate.id);
    expect((await targetPrompts(stored?.targetCaseIds ?? [])).sort()).toEqual([
      'a bad question from yesterday',
      'another bad one',
    ]);
    // The well-scored turn and the errored (never graded) turn are not targets,
    // and nothing else was frozen on the side.
    expect((await listCases(storage, DATA, PID)).map((c) => c.prompt).sort()).toEqual([
      'a bad question from yesterday',
      'another bad one',
    ]);
    // Each target carries its session context, as every other session case does.
    const another = (await listCases(storage, DATA, PID)).find(
      (c) => c.prompt === 'another bad one',
    );
    expect(another?.context).toEqual(['a perfectly fine request', 'ok']);
  });

  it('a run with no zero-scored prompts yields no target cases, and no fallback fills them', async () => {
    await seed('cli:project', [
      ['a perfectly fine request', 'ok'],
      ['another fine request', 'ok'],
    ]);
    const recent = await judgeRun();

    const targetCaseIds = await freezeTargetTurnCases(
      ctx,
      PID,
      judgeZeroScoredTurns(await storage.read(RUN_FILE), recent.turns),
    );
    const candidate = await submitExpressionCandidate(ctx, {
      personalityId: PID,
      origin: 'nightly',
      newExpression: 'I speak plainly.\n',
      rationale: 'r',
      evidenceRef: 'nightly:0.80@w',
      targetCaseIds,
    });

    expect((await readCandidate(storage, DATA, candidate.id))?.targetCaseIds).toEqual([]);
    expect(await listCases(storage, DATA, PID)).toEqual([]);
    // A missing run file is the same answer, not an error.
    expect(judgeZeroScoredTurns(null, recent.turns)).toEqual([]);
  });
});

describe('nightly skill target cases (Design §2)', () => {
  const GOOD_DRAFT = '<filename>x.md</filename>\n<skill>When asked to X, do Y.</skill>';

  it("a nightly skill candidate's target cases are exactly the turns buildEvidenceDigest reported using", async () => {
    // Each digest line is capped at ~400 chars, so five long turns in the
    // newer session fill the 4000-char digest before its own first question
    // and before the older session: both are recent turns the digest did NOT
    // quote.
    await seed('cli:older', [['an older turn the digest never reaches', 'old answer']]);
    const long = (label: string) => `${label} ${'x'.repeat(1200)}`;
    await seed(
      'cli:newer',
      [1, 2, 3, 4, 5].map((n) => [long(`newer question ${n}`), long(`newer answer ${n}`)]),
    );

    const built = await buildEvidenceDigest(store, PID);
    expect(built.digest).toContain('[evidence truncated]');
    expect(built.digest).not.toContain('an older turn the digest never reaches');
    expect(built.digest).not.toContain('newer question 1 ');
    expect(built.userTurns.every((t) => built.messageIds.includes(t.messageId))).toBe(true);

    const targetCaseIds = await freezeTargetTurnCases(ctx, PID, built.userTurns);
    const result = await proposeSkillFromEvidence({
      personalityId: PID,
      evidenceDigest: built.digest,
      windowEnd: '2026-09-13T00:00:00.000Z',
      dataDir: DATA,
      llm: textLLM(() => GOOD_DRAFT),
      learning: learningSubmitPort(ctx),
      evidenceSessionIds: built.sessionIds,
      targetCaseIds,
    });
    const stored = await readCandidate(storage, DATA, result.candidateId ?? '');

    const refs: string[] = [];
    for (const id of stored?.targetCaseIds ?? []) {
      refs.push((await readCase(storage, DATA, PID, id))?.sourceRef ?? '?');
    }
    // Digest order (newest first), capped at MAX_TARGET_CASES.
    expect(built.userTurns.length).toBeGreaterThan(3);
    expect(refs).toEqual(built.userTurns.slice(0, 3).map((t) => `session:${t.messageId}`));
    const prompts = await targetPrompts(stored?.targetCaseIds ?? []);
    expect(prompts).not.toContain('an older turn the digest never reaches');
    expect(prompts.some((p) => p.startsWith('newer question 1 '))).toBe(false);
    expect(stored?.evidence.sessionIds).toEqual(built.sessionIds);
  });

  it('existing buildEvidenceDigest callers still get digest and hasSessions', async () => {
    await seed('cli:project', [['hello there', 'hi']]);
    const built = await buildEvidenceDigest(store, PID);
    expect(built.hasSessions).toBe(true);
    expect(built.digest).toBe('assistant: hi\nuser: hello there');
    expect(built.messageIds).toHaveLength(2);
    expect(built.userTurns.map((t) => t.prompt)).toEqual(['hello there']);
  });
});

describe('an evidence turn under an excluded prefix never becomes a target case', () => {
  it.each([...LEARNING_EXCLUDED_KEY_PREFIXES])('%s', async (prefix) => {
    await seed(`${prefix}machine`, [['a bad machine-driven turn', 'meh']]);
    await seed('cli:project', [['a real bad question', 'meh']]);

    // Through the real evidence functions: the SQLite filter keeps it out.
    const built = await buildEvidenceDigest(store, PID);
    expect(built.userTurns.map((t) => t.prompt)).toEqual(['a real bad question']);
    const recent = await judgeRun();
    const expressionTargets = await freezeTargetTurnCases(
      ctx,
      PID,
      judgeZeroScoredTurns(await storage.read(RUN_FILE), recent.turns),
    );
    expect(await targetPrompts(expressionTargets)).toEqual(['a real bad question']);

    // And at the freeze itself, for a turn that reached it some other way.
    const direct = await freezeTargetTurnCases(ctx, 'other', [
      { sessionKey: `${prefix}machine`, messageId: 'm1', prompt: 'a bad machine-driven turn' },
    ]);
    expect(direct).toEqual([]);
    expect(await listCases(storage, DATA, 'other')).toEqual([]);
  });
});
