// Gap 2 — the regression top-up. Rule (a) needs a regression case, and without
// a nightly pass the frozen pool is empty, so an on-demand replay could only
// ever say `incomplete`. `replayCandidate` now tops the pool up from recent
// sessions through `captureCases` — and never touches target cases, never
// lowers rule (a). The arms and the grader are scripted fakes.

import { InMemorySessionStore } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { AgentEvent, CompletionChunk, LLMProvider } from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CASE_FREEZE_BATCH,
  CASE_POOL_CAP,
  caseIdFor,
  freezeCase,
  LEARNING_EXCLUDED_KEY_PREFIXES,
  type LearningCase,
  listCases,
  type SessionCaseTurn,
} from '../cases';
import { casePath } from '../paths';
import {
  type CreateReplayArm,
  type RegressionTopUp,
  type ReplayCandidateDeps,
  regressionShortfall,
  replayCandidate,
} from '../replay';
import { submitCandidate, updateCandidate } from '../store';

const DATA = '/ethos';
const PID = 'researcher';

let storage: InMemoryStorage;
let clock: number;
const now = () => {
  clock += 1000;
  return clock;
};

function evalCase(id: string, frozenAt: string, value = 'hello'): LearningCase {
  return {
    id,
    personalityId: PID,
    prompt: `prompt ${id}`,
    context: [],
    assertions: [{ kind: 'contains', value }],
    source: 'eval',
    sourceRef: `eval:${id}`,
    frozenAt,
  };
}

/** A case `selectReplayCases` skips: more criteria than are graded per case. */
function ungradable(id: string, frozenAt: string): LearningCase {
  return {
    ...evalCase(id, frozenAt),
    assertions: [1, 2, 3, 4].map((n) => ({ kind: 'criteria' as const, value: `c${n}` })),
  };
}

/** Candidate says GOOD on the target; both arms say hello everywhere else → Δ 0. */
const arms: CreateReplayArm = async ({ arm }) => ({
  loop: {
    async *run(_prompt, options): AsyncIterable<AgentEvent> {
      const caseId = options.sessionKey.split(':').at(-1);
      let text = 'hello';
      if (caseId === 'target') text = arm === 'candidate' ? 'GOOD' : 'weak';
      yield { type: 'done', text, turnCount: 1 };
    },
  },
  dispose: async () => {},
});

/** Grades every `criteria` assertion as met, in both arms alike. */
const passingGrader: LLMProvider = {
  name: 'grader',
  model: 'grader',
  maxContextTokens: 8_192,
  supportsCaching: false,
  supportsThinking: false,
  async *complete(): AsyncIterable<CompletionChunk> {
    yield { type: 'text_delta', text: '1' };
  },
  async countTokens() {
    return 0;
  },
};

function turns(count: number, sessionKey = 'cli:project', from = 0): SessionCaseTurn[] {
  return Array.from({ length: count }, (_, i) => ({
    sessionKey,
    messageId: `${sessionKey}-m${from + i}`,
    prompt: `question ${from + i}`,
  }));
}

function topUp(list: SessionCaseTurn[]) {
  const sessionTurns = vi.fn(async (_pid: string) => list);
  const value: RegressionTopUp = { core: async () => 'I am careful.', sessionTurns };
  return { topUp: value, sessionTurns };
}

function deps(regressionTopUp?: RegressionTopUp): ReplayCandidateDeps {
  return {
    storage,
    dataDir: DATA,
    createArm: arms,
    newSession: () => new InMemorySessionStore(),
    grader: passingGrader,
    runOptions: { dryRun: true, temperature: 0 },
    settings: { maxCases: 8, maxCostUsd: 0.5 },
    shadowFor: async (c) => ({ path: c.destination, content: c.content }),
    ...(regressionTopUp ? { regressionTopUp } : {}),
    now,
  };
}

async function submitWithTargets(targetCaseIds: string[]) {
  return submitCandidate(storage, DATA, {
    kind: 'skill',
    op: 'create',
    personalityId: PID,
    origin: 'fork',
    destination: `${DATA}/personalities/${PID}/skills/cite.md`,
    content: '---\nname: cite\ndescription: "Always cite"\n---\n\nCite every claim.\n',
    targetCaseIds,
  });
}

const sessionCaseIds = async () =>
  (await listCases(storage, DATA, PID)).filter((c) => c.source === 'session').map((c) => c.id);

beforeEach(() => {
  storage = new InMemoryStorage();
  clock = Date.parse('2026-09-13T00:00:00.000Z');
});

describe('regressionShortfall', () => {
  const t = evalCase('target', '2026-09-01T00:00:00.000Z');
  const r = (n: number) => evalCase(`reg-${n}`, `2026-09-01T00:00:0${n}.000Z`);
  it.each([
    ['one target, empty pool → 2', [t], [], 8, 2],
    ['one target, one regression → 1', [t], [r(1)], 8, 1],
    ['one target, two regressions → 0', [t], [r(1), r(2)], 8, 0],
    ['no target → 3 (a top-up cannot make a target)', [], [], 8, 3],
    ['the target itself in the pool is not a regression case', [t], [t, r(1)], 8, 1],
    [
      'an ungradable pool case does not count',
      [t],
      [ungradable('u', '2026-09-01T00:00:09.000Z')],
      8,
      2,
    ],
  ] as const)('%s', (_name, targets, pool, maxCases, expected) => {
    expect(regressionShortfall(targets, pool, maxCases)).toBe(expected);
  });
});

describe('replayCandidate — regression top-up', () => {
  it('a personality with no regression cases gets a pool on its first replay and reaches a verdict', async () => {
    await freezeCase(storage, DATA, evalCase('target', '2026-09-01T00:00:00.000Z', 'GOOD'));
    const c = await submitWithTargets(['target']);
    const { topUp: t, sessionTurns } = topUp(turns(3));

    const without = await replayCandidate(deps(), c.id);
    expect(without.report.verdict).toBe('incomplete');

    const { report } = await replayCandidate(deps(t), c.id);

    expect(sessionTurns).toHaveBeenCalledWith(PID);
    expect(await sessionCaseIds()).toHaveLength(3);
    expect(report.cases.filter((x) => x.role === 'regression')).toHaveLength(3);
    expect(report.verdict).toBe('pass');
  });

  it('never freezes a session under an excluded key prefix', async () => {
    await freezeCase(storage, DATA, evalCase('target', '2026-09-01T00:00:00.000Z', 'GOOD'));
    const c = await submitWithTargets(['target']);
    const excluded = LEARNING_EXCLUDED_KEY_PREFIXES.flatMap((prefix) => turns(2, `${prefix}x`));
    const { topUp: t } = topUp(excluded);

    const { report } = await replayCandidate(deps(t), c.id);

    expect(await sessionCaseIds()).toEqual([]);
    for (const turn of excluded) {
      const id = caseIdFor('session', `session:${turn.messageId}`);
      expect(await storage.exists(casePath(DATA, PID, id))).toBe(false);
    }
    expect(report.verdict).toBe('incomplete');
  });

  it('a candidate with no target case is still incomplete after the top-up', async () => {
    const c = await submitWithTargets([]);
    const { topUp: t } = topUp(turns(5));

    const { report } = await replayCandidate(deps(t), c.id);

    expect(await sessionCaseIds()).toHaveLength(5);
    expect(report.cases.some((x) => x.role === 'target')).toBe(false);
    expect(report.rules.a).toBe(false);
    expect(report.verdict).toBe('incomplete');
  });

  it('never rewrites a target case, and never counts it as a regression case', async () => {
    // The target was frozen from the same session turn the top-up will see.
    const [shared] = turns(1);
    if (!shared) throw new Error('fixture');
    const targetId = caseIdFor('session', `session:${shared.messageId}`);
    const target: LearningCase = {
      ...evalCase(targetId, '2026-09-01T00:00:00.000Z', 'GOOD'),
      source: 'session',
      sourceRef: `session:${shared.messageId}`,
    };
    await freezeCase(storage, DATA, target);
    const before = await storage.read(casePath(DATA, PID, targetId));
    const c = await submitWithTargets([targetId]);
    const { topUp: t } = topUp(turns(3));

    const { report } = await replayCandidate(deps(t), c.id);

    expect(await storage.read(casePath(DATA, PID, targetId))).toBe(before);
    expect(report.cases.filter((x) => x.caseId === targetId).map((x) => x.role)).toEqual([
      'target',
    ]);
  });

  it('respects the freeze batch and the pool cap, and the cap never evicts a target', async () => {
    // The target is the OLDEST case in a pool of 39, so FIFO eviction would take it first.
    await freezeCase(storage, DATA, evalCase('target', '2026-08-01T00:00:00.000Z', 'GOOD'));
    for (let i = 0; i < CASE_POOL_CAP - 2; i++) {
      await freezeCase(
        storage,
        DATA,
        ungradable(
          `old-${String(i).padStart(2, '0')}`,
          `2026-08-02T00:00:${String(i).padStart(2, '0')}.000Z`,
        ),
      );
    }
    const c = await submitWithTargets(['target']);
    const { topUp: t } = topUp(turns(CASE_FREEZE_BATCH + 5));

    const { report } = await replayCandidate(deps(t), c.id);

    const pool = await listCases(storage, DATA, PID);
    expect(await sessionCaseIds()).toHaveLength(CASE_FREEZE_BATCH);
    expect(pool).toHaveLength(CASE_POOL_CAP);
    expect(pool.some((x) => x.id === 'target')).toBe(true);
    expect(report.verdict).toBe('pass');
  });

  it("a top-up for one candidate never evicts another pending candidate's target", async () => {
    // `other` is the OLDEST case in a full pool and belongs to a candidate still in review.
    await freezeCase(storage, DATA, evalCase('other', '2026-07-01T00:00:00.000Z'));
    await freezeCase(storage, DATA, evalCase('target', '2026-08-01T00:00:00.000Z', 'GOOD'));
    for (let i = 0; i < CASE_POOL_CAP - 2; i++) {
      await freezeCase(
        storage,
        DATA,
        ungradable(
          `old-${String(i).padStart(2, '0')}`,
          `2026-08-02T00:00:${String(i).padStart(2, '0')}.000Z`,
        ),
      );
    }
    const other = await submitWithTargets(['other']);
    await updateCandidate(storage, DATA, other.id, { status: 'pending_review' });
    const c = await submitWithTargets(['target']);
    const { topUp: t } = topUp(turns(3));

    await replayCandidate(deps(t), c.id);

    const pool = await listCases(storage, DATA, PID);
    expect(await sessionCaseIds()).toHaveLength(3);
    expect(pool).toHaveLength(CASE_POOL_CAP);
    expect(pool.map((x) => x.id)).toEqual(expect.arrayContaining(['other', 'target']));
    expect(pool.map((x) => x.id)).not.toContain('old-00');
  });

  it('too few eligible sessions still yields incomplete', async () => {
    await freezeCase(storage, DATA, evalCase('target', '2026-09-01T00:00:00.000Z', 'GOOD'));
    const c = await submitWithTargets(['target']);
    const { topUp: t } = topUp(turns(1));

    const { report } = await replayCandidate(deps(t), c.id);

    expect(await sessionCaseIds()).toHaveLength(1);
    expect(report.stopReason).toBe('insufficient_cases');
    expect(report.verdict).toBe('incomplete');
  });

  it('does not read sessions when the pool already satisfies rule (a)', async () => {
    await freezeCase(storage, DATA, evalCase('target', '2026-09-01T00:00:00.000Z', 'GOOD'));
    await freezeCase(storage, DATA, evalCase('reg-a', '2026-09-01T00:00:01.000Z'));
    await freezeCase(storage, DATA, evalCase('reg-b', '2026-09-01T00:00:02.000Z'));
    const c = await submitWithTargets(['target']);
    const { topUp: t, sessionTurns } = topUp(turns(3));

    const { report } = await replayCandidate(deps(t), c.id);

    expect(sessionTurns).not.toHaveBeenCalled();
    expect(report.verdict).toBe('pass');
  });
});
