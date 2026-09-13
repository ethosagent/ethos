// L-T4 — the replay runner: run options, isolation of the grader from the arm,
// the budget stop, loop disposal, case selection, and the recorded verdict.
//
// The arms here are scripted fakes of `CreateAgentLoopResult`. What a REAL
// replay loop does with these options — no write, no tool execution, no outbox
// row — is pinned by `packages/wiring/src/__tests__/replay-isolation.test.ts`.

import { InMemorySessionStore } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  Message,
  SessionStore,
} from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { type CaseAssertion, freezeCase, type LearningCase } from '../cases';
import {
  type CreateReplayArm,
  type CreateReplayArmInput,
  type ReplayBaseRunOptions,
  type ReplayTurnOptions,
  replayCandidate,
  runReplay,
  selectReplayCases,
} from '../replay';
import { readCandidate, readReplayRun, submitCandidate } from '../store';
import { computeVerdict } from '../verdict';

const PID = 'researcher';
const CID = 'c-1';
const RUN_OPTIONS: ReplayBaseRunOptions = { dryRun: true, temperature: 0 };
const SHADOW = { path: '/ethos/skills/new.md', content: 'shadow bytes' };

let at = 0;
function makeCase(id: string, assertions: CaseAssertion[], extra?: Partial<LearningCase>) {
  at += 1;
  return {
    id,
    personalityId: PID,
    prompt: `prompt for ${id}`,
    context: [],
    assertions,
    source: 'eval',
    sourceRef: `eval:${id}`,
    frozenAt: new Date(Date.UTC(2026, 8, 1, 0, 0, at)).toISOString(),
    ...extra,
  } satisfies LearningCase;
}

/** A turn's events: text, an optional plan, optional usage cost, optional error/halt. */
function turn(opts: {
  text: string;
  tools?: string[];
  cost?: number;
  error?: boolean;
  halt?: boolean;
}): AgentEvent[] {
  const events: AgentEvent[] = [];
  if (opts.cost !== undefined) {
    events.push({ type: 'usage', inputTokens: 1, outputTokens: 1, estimatedCostUsd: opts.cost });
  }
  events.push({ type: 'text_delta', text: opts.text });
  if (opts.error) events.push({ type: 'error', error: 'stream failed', code: 'llm_error' });
  if (opts.halt) {
    events.push({ type: 'halt', kind: 'budget', rule: 'tool-budget', message: 'too many calls' });
  }
  events.push({ type: 'done', text: opts.text, turnCount: 1 });
  if (opts.tools?.length) {
    events.push({
      type: 'dry_run_summary',
      plan: opts.tools.map((toolName, i) => ({ toolCallId: `t${i}`, toolName, args: {} })),
      capped: 0,
    });
  }
  return events;
}

interface Harness {
  createArm: CreateReplayArm;
  created: CreateReplayArmInput[];
  disposed: number;
  runs: { arm: string; prompt: string; options: ReplayTurnOptions; session: SessionStore }[];
  aborted: string[];
}

/** `script(arm, caseId)` returns the arm's events, or throws to simulate a broken case. */
function harness(script: (arm: string, caseId: string) => AgentEvent[]): Harness {
  const h: Harness = {
    created: [],
    disposed: 0,
    runs: [],
    aborted: [],
    createArm: async (input) => {
      h.created.push(input);
      return {
        loop: {
          async *run(prompt, options) {
            h.runs.push({ arm: input.arm, prompt, options, session: input.session });
            const caseId = options.sessionKey.split(':').at(-1) ?? '';
            for (const event of script(input.arm, caseId)) {
              if (options.abortSignal.aborted) {
                h.aborted.push(options.sessionKey);
                yield { type: 'error', error: 'aborted', code: 'aborted' };
                return;
              }
              yield event;
            }
          },
        },
        dispose: async () => {
          h.disposed += 1;
        },
      };
    },
  };
  return h;
}

/** A grader that passes any response containing "GOOD", and records every prompt it was sent. */
function grader(): LLMProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    name: 'grader',
    model: 'grader',
    maxContextTokens: 8_192,
    supportsCaching: false,
    supportsThinking: false,
    capabilities: { streaming: true, toolCalling: false },
    async *complete(messages: Message[]): AsyncIterable<CompletionChunk> {
      const text = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('');
      prompts.push(text);
      const response = text.split('Response:\n')[1] ?? '';
      yield { type: 'text_delta', text: response.includes('GOOD') ? '1' : '0' };
    },
    async countTokens() {
      return 0;
    },
  };
}

/** One target and two regressions; the candidate improves the target and holds the rest. */
function standardCases() {
  const target = makeCase('target-1', [
    { kind: 'criteria', value: 'answers the question' },
    { kind: 'tool_called', value: 'web_search' },
  ]);
  const reg1 = makeCase('reg-1', [{ kind: 'contains', value: 'hello' }]);
  const reg2 = makeCase('reg-2', [{ kind: 'tool_not_called', value: 'send_message' }]);
  return { target, pool: [reg1, reg2] };
}

function standardScript(arm: string, caseId: string): AgentEvent[] {
  if (caseId === 'target-1') {
    return arm === 'candidate'
      ? turn({ text: 'GOOD answer', tools: ['web_search'], cost: 0.01 })
      : turn({ text: 'weak answer', cost: 0.01 });
  }
  if (caseId === 'reg-1') return turn({ text: 'hello there', cost: 0.01 });
  return turn({ text: 'done', tools: ['read_file'], cost: 0.01 });
}

function input(
  h: Harness,
  g: LLMProvider,
  overrides: Partial<Parameters<typeof runReplay>[0]> = {},
) {
  const { target, pool } = standardCases();
  return {
    candidateId: CID,
    personalityId: PID,
    shadow: SHADOW,
    targetCases: [target],
    regressionPool: pool,
    createArm: h.createArm,
    newSession: () => new InMemorySessionStore(),
    grader: g,
    runOptions: RUN_OPTIONS,
    maxCases: 8,
    maxCostUsd: 0.5,
    ...overrides,
  };
}

beforeEach(() => {
  at = 0;
});

describe('runReplay', () => {
  it('runs every case through a baseline and a candidate arm and scores a pass', async () => {
    const h = harness(standardScript);
    const report = await runReplay(input(h, grader()));

    expect(report.verdict).toBe('pass');
    expect(report.stopReason).toBeNull();
    expect(report.cases.map((c) => [c.caseId, c.role])).toEqual([
      ['target-1', 'target'],
      ['reg-2', 'regression'],
      ['reg-1', 'regression'],
    ]);
    const target = report.cases[0];
    // criteria + tool_called + completed: baseline passes only `completed`.
    expect(target?.baseline?.score).toBeCloseTo(1 / 3);
    expect(target?.candidate?.score).toBe(1);
    expect(target?.candidate?.plan.map((p) => p.toolName)).toEqual(['web_search']);
    expect(report.costUsd).toBeCloseTo(0.06);
    expect(report.testedOn).toBe(PID);
    expect(report.limitations.length).toBeGreaterThan(0);

    // The candidate arm carries the shadow; the baseline carries none.
    expect(h.created.map((c) => [c.arm, c.shadow])).toEqual([
      ['baseline', null],
      ['candidate', SHADOW],
      ['baseline', null],
      ['candidate', SHADOW],
      ['baseline', null],
      ['candidate', SHADOW],
    ]);
  });

  it('records RunOptions with dryRun: true and temperature: 0 on every turn', async () => {
    const h = harness(standardScript);
    await runReplay(input(h, grader()));

    expect(h.runs).toHaveLength(6);
    for (const run of h.runs) {
      expect(run.options).toMatchObject({
        dryRun: true,
        temperature: 0,
        dryRunMaxToolCalls: 8,
        personalityId: PID,
        sessionKey: `replay:${CID}:${run.arm}:${run.options.sessionKey.split(':').at(-1)}`,
      });
    }
    expect(h.runs[0]?.options.sessionKey).toBe(`replay:${CID}:baseline:target-1`);
  });

  it('refuses run options that are not a dry run', async () => {
    const h = harness(standardScript);
    const notDry = { dryRun: false, temperature: 0 } as unknown as ReplayBaseRunOptions;
    await expect(runReplay(input(h, grader(), { runOptions: notDry }))).rejects.toThrow(/dryRun/);
    expect(h.created).toHaveLength(0);
  });

  it('sends the grader one response at a time with no arm label', async () => {
    const h = harness(standardScript);
    const g = grader();
    await runReplay(input(h, g));

    // One criteria assertion on one case, graded once per arm.
    expect(g.prompts).toHaveLength(2);
    expect(g.prompts.some((p) => p.includes('weak answer'))).toBe(true);
    expect(g.prompts.some((p) => p.includes('GOOD answer'))).toBe(true);
    for (const prompt of g.prompts) {
      expect(prompt).not.toMatch(/baseline|candidate|replay:|\barm\b/i);
      // One response per prompt: never both arms' texts together.
      expect(prompt.includes('weak answer') && prompt.includes('GOOD answer')).toBe(false);
    }
  });

  it('seeds the case context into the session before the turn', async () => {
    const withContext = makeCase('target-ctx', [{ kind: 'contains', value: 'x' }], {
      context: ['first user line', 'assistant reply', 'second user line', 'assistant again'],
    });
    const seen: { role: string; content: string }[][] = [];
    const h = harness(() => turn({ text: 'x' }));
    const createArm: CreateReplayArm = async (arm) => {
      const runtime = await h.createArm(arm);
      return {
        dispose: runtime.dispose,
        loop: {
          async *run(prompt, options) {
            const session = await arm.session.getSessionByKey(options.sessionKey);
            const messages = session ? await arm.session.getMessages(session.id) : [];
            seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
            expect(session?.personalityId).toBe(PID);
            yield* runtime.loop.run(prompt, options);
          },
        },
      };
    };
    const { pool } = standardCases();
    await runReplay(
      input(h, grader(), { targetCases: [withContext], regressionPool: pool, createArm }),
    );

    expect(seen[0]).toEqual([
      { role: 'user', content: 'first user line' },
      { role: 'assistant', content: 'assistant reply' },
      { role: 'user', content: 'second user line' },
      { role: 'assistant', content: 'assistant again' },
    ]);
  });

  it('scores the implicit completed check: an error or a halt fails it', async () => {
    const h = harness((arm, caseId) => {
      if (caseId === 'target-1') {
        return arm === 'candidate'
          ? turn({ text: 'GOOD answer', tools: ['web_search'] })
          : turn({ text: 'weak answer' });
      }
      if (caseId === 'reg-1') return turn({ text: 'hello', halt: arm === 'candidate' });
      return turn({ text: 'done', error: arm === 'candidate' });
    });
    const report = await runReplay(input(h, grader()));
    const reg1 = report.cases.find((c) => c.caseId === 'reg-1');
    expect(reg1?.baseline?.completed).toBe(true);
    expect(reg1?.candidate?.completed).toBe(false);
    expect(reg1?.candidate?.halts).toHaveLength(1);
    expect(reg1?.candidate?.assertions.at(-1)).toMatchObject({ kind: 'completed', passed: false });
    // Rule (b): the candidate broke completion where the baseline held it.
    expect(report.rules.b).toBe(false);
    expect(report.verdict).toBe('regress');
  });

  it('stops over budget with verdict incomplete, aborting the arm that crossed it', async () => {
    const h = harness((arm, caseId) => [
      { type: 'usage', inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.2 },
      // A second usage event in the same turn — the abort lands before it.
      ...turn({ text: `${arm} ${caseId}`, cost: 0.2 }),
    ]);
    const report = await runReplay(input(h, grader(), { maxCostUsd: 0.5 }));

    expect(report.verdict).toBe('incomplete');
    expect(report.stopReason).toBe('budget');
    expect(report.rules.a).toBe(false);
    expect(report.costUsd).toBeGreaterThan(0.5);
    // Baseline of the first case spent 0.4; the candidate arm crossed 0.5 and was aborted.
    expect(h.aborted).toEqual([`replay:${CID}:candidate:target-1`]);
    // No case after the stop ran, and every loop that was built was disposed.
    expect(h.created).toHaveLength(2);
    expect(h.disposed).toBe(2);
    expect(report.cases.every((c) => c.delta === null)).toBe(true);
  });

  it('disposes every loop, including when a case throws, and ends incomplete', async () => {
    const h = harness((arm, caseId) => {
      if (caseId === 'reg-2' && arm === 'candidate') throw new Error('MCP child died');
      return standardScript(arm, caseId);
    });
    const report = await runReplay(input(h, grader()));

    expect(report.verdict).toBe('incomplete');
    expect(report.stopReason).toBe('error');
    expect(report.error).toBe('MCP child died');
    // target-1 (2 arms) + reg-2 (2 arms, the second threw); reg-1 never started.
    expect(h.created).toHaveLength(4);
    expect(h.disposed).toBe(h.created.length);
    expect(report.cases.find((c) => c.caseId === 'reg-2')?.candidate).toBeNull();
  });

  it('stops with error and leaks no loop when a later arm cannot get a session', async () => {
    const h = harness(standardScript);
    let sessions = 0;
    const newSession = () => {
      sessions += 1;
      if (sessions === 2) throw new Error('session store unavailable');
      return new InMemorySessionStore();
    };
    const report = await runReplay(input(h, grader(), { newSession }));
    expect(report.stopReason).toBe('error');
    expect(h.disposed).toBe(h.created.length);
  });

  it('spends nothing when there are too few cases, no target, or no regression case', async () => {
    const h = harness(standardScript);
    const { target, pool } = standardCases();

    const tooFew = await runReplay(
      input(h, grader(), { targetCases: [target], regressionPool: [pool[0] as LearningCase] }),
    );
    expect(tooFew.verdict).toBe('incomplete');
    expect(tooFew.stopReason).toBe('insufficient_cases');

    const noTarget = await runReplay(
      input(h, grader(), { targetCases: [], regressionPool: [...pool, target] }),
    );
    expect(noTarget.verdict).toBe('incomplete');
    expect(noTarget.stopReason).toBe('insufficient_cases');

    const noRegression = await runReplay(
      input(h, grader(), {
        targetCases: [target, makeCase('target-2', []), makeCase('target-3', [])],
        regressionPool: [],
      }),
    );
    expect(noRegression.verdict).toBe('incomplete');
    expect(noRegression.stopReason).toBe('insufficient_cases');
    expect(noRegression.rules.a).toBe(false);

    expect(h.created).toHaveLength(0);
  });
});

describe('selectReplayCases (L-D6)', () => {
  const one: CaseAssertion[] = [{ kind: 'contains', value: 'x' }];

  it('takes at most 3 targets and fills to 8 with the newest regression cases', () => {
    const targets = ['t1', 't2', 't3', 't4'].map((id) => makeCase(id, one));
    const pool = Array.from({ length: 10 }, (_, i) => makeCase(`r${i}`, one));
    const { selected, skipped } = selectReplayCases(
      targets,
      [...pool, targets[0] as LearningCase],
      20,
    );

    expect(selected).toHaveLength(8);
    expect(selected.filter((s) => s.role === 'target').map((s) => s.case.id)).toEqual([
      't1',
      't2',
      't3',
    ]);
    expect(selected.filter((s) => s.role === 'regression').map((s) => s.case.id)).toEqual([
      'r9',
      'r8',
      'r7',
      'r6',
      'r5',
    ]);
    expect(skipped).toEqual([{ caseId: 't4', reason: 'more than 3 target cases' }]);
  });

  it('honours a smaller maxCases', () => {
    const pool = Array.from({ length: 10 }, (_, i) => makeCase(`r${i}`, one));
    const { selected } = selectReplayCases([makeCase('t1', one)], pool, 4);
    expect(selected).toHaveLength(4);
  });

  it('keeps one slot for a regression case when targets would fill every slot', () => {
    const targets = ['t1', 't2', 't3'].map((id) => makeCase(id, one));
    const pool = Array.from({ length: 5 }, (_, i) => makeCase(`r${i}`, one));
    const { selected, skipped } = selectReplayCases(targets, pool, 3);

    expect(selected.map((s) => [s.role, s.case.id])).toEqual([
      ['target', 't1'],
      ['target', 't2'],
      ['regression', 'r4'],
    ]);
    expect(skipped).toEqual([
      {
        caseId: 't3',
        reason: 'more than 2 target cases; one of 3 slots is kept for a regression case',
      },
    ]);
  });

  it('a 3-target selection at maxCases 3 still reaches a passing verdict', () => {
    const targets = ['t1', 't2', 't3'].map((id) => makeCase(id, one));
    const pool = [makeCase('r0', one)];
    const { selected } = selectReplayCases(targets, pool, 3);
    const verdict = computeVerdict({
      cases: selected.map((s) => ({
        caseId: s.case.id,
        role: s.role,
        baseline: { score: s.role === 'target' ? 0.5 : 1, completed: true },
        candidate: { score: 1, completed: true },
      })),
      withinBudget: true,
    });
    expect(verdict.verdict).toBe('pass');
  });

  it('skips a case with more criteria than the grader bound allows', () => {
    const criteria = (n: number): CaseAssertion[] =>
      Array.from({ length: n }, (_, i) => ({ kind: 'criteria', value: `c${i}` }));
    const { selected, skipped } = selectReplayCases(
      [makeCase('t-many', criteria(4)), makeCase('t-ok', criteria(3))],
      [],
      8,
    );
    expect(selected.map((s) => s.case.id)).toEqual(['t-ok']);
    expect(skipped[0]?.caseId).toBe('t-many');
  });
});

describe('replayCandidate', () => {
  const DATA = '/ethos';
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
  });

  it('records the scorecard and the verdict, moving pending_replay to pending_review', async () => {
    const { target, pool } = standardCases();
    for (const c of [target, ...pool]) await freezeCase(storage, DATA, c);
    const submitted = await submitCandidate(storage, DATA, {
      kind: 'skill',
      op: 'create',
      personalityId: PID,
      origin: 'fork',
      destination: SHADOW.path,
      content: SHADOW.content,
      targetCaseIds: [target.id, 'missing-case'],
    });

    const h = harness(standardScript);
    const shadowsBuiltFor: string[] = [];
    const { candidate, report } = await replayCandidate(
      {
        storage,
        dataDir: DATA,
        createArm: h.createArm,
        newSession: () => new InMemorySessionStore(),
        grader: grader(),
        runOptions: RUN_OPTIONS,
        settings: { maxCases: 8, maxCostUsd: 0.5 },
        shadowFor: async (c) => {
          shadowsBuiltFor.push(c.id);
          return { path: c.destination, content: c.content };
        },
      },
      submitted.id,
    );

    expect(shadowsBuiltFor).toEqual([submitted.id]);
    expect(report.verdict).toBe('pass');
    expect(report.skipped).toContainEqual({
      caseId: 'missing-case',
      reason: 'target case not found',
    });
    expect(candidate.status).toBe('pending_review');
    expect(candidate.verdict).toBe('pass');
    expect((await readCandidate(storage, DATA, submitted.id))?.verdict).toBe('pass');
    expect(await readReplayRun(storage, DATA, submitted.id, report.runId)).toMatchObject({
      verdict: 'pass',
      runId: report.runId,
    });
    expect(h.disposed).toBe(h.created.length);
  });
});
