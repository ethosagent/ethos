// L-T6 — the one auto resolver (L-D3) and the one non-human promotion path
// (L-D1, L-D11). The arms are scripted fakes; what a real replay loop does is
// pinned by `packages/wiring/src/__tests__/replay-isolation.test.ts`.

import { join } from 'node:path';
import { InMemorySessionStore } from '@ethosagent/core';
import { liveSkillDir } from '@ethosagent/skill-evolver';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { AgentEvent, CompletionChunk, LLMProvider } from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// Relative on purpose, as in `promote.test.ts`: the real frontmatter gate.
import { vetPromotedSkill } from '../../../skills/src/promotion-vet';
import { checkSkillFrontmatter } from '../../../skills/src/skill-compat';
import {
  type AutoPromotionKnobs,
  autoPromotionDecision,
  explainAutoPromotion,
  LEARNING_AUTO_PROMOTE_CODE,
  type ReplayAndResolveDeps,
  replayAndResolve,
  resolveAutoPromotion,
} from '../auto-promotion';
import { freezeCase, type LearningCase } from '../cases';
import type { LearningObservability } from '../inbox';
import type { ExpressionRevisions, SkillScope } from '../promote';
import type { CreateReplayArm } from '../replay';
import { readCandidate, submitCandidate } from '../store';

const DATA = '/ethos';
const PID = 'researcher';
const SKILL = '---\nname: cite\ndescription: "Always cite"\n---\n\nCite every claim.\n';

describe('resolveAutoPromotion (L-D3)', () => {
  const cases: Array<[string, 'skill' | 'expression', AutoPromotionKnobs, 'auto' | 'review']> = [
    ['nothing set → review', 'skill', {}, 'review'],
    ['global autoApprove alone → auto', 'skill', { globalAutoApprove: true }, 'auto'],
    [
      'approval mode user beats global autoApprove',
      'skill',
      { approvalMode: 'user', globalAutoApprove: true },
      'review',
    ],
    ['approval mode auto beats global off', 'skill', { approvalMode: 'auto' }, 'auto'],
    [
      'promotion review beats approval mode auto',
      'skill',
      { promotion: 'review', approvalMode: 'auto', globalAutoApprove: true },
      'review',
    ],
    [
      'promotion auto beats approval mode user',
      'skill',
      { promotion: 'auto', approvalMode: 'user' },
      'auto',
    ],
    ['expression: approval mode auto → auto', 'expression', { approvalMode: 'auto' }, 'auto'],
    ['expression: absent mode → review', 'expression', {}, 'review'],
    [
      'expression ignores the skill knobs',
      'expression',
      { promotion: 'auto', globalAutoApprove: true },
      'review',
    ],
  ];
  for (const [name, kind, knobs, expected] of cases) {
    it(name, () => {
      expect(resolveAutoPromotion(kind, knobs)).toBe(expected);
    });
  }

  it('explainAutoPromotion names the knob that decided', () => {
    expect(explainAutoPromotion('skill', { promotion: 'auto', globalAutoApprove: true })).toEqual({
      mode: 'auto',
      knob: 'skill_evolution.promotion',
    });
    expect(explainAutoPromotion('skill', { globalAutoApprove: true }).knob).toBe('autoApprove');
    expect(explainAutoPromotion('expression', { approvalMode: 'auto' }).knob).toBe(
      'evolution_approval_mode',
    );
    expect(explainAutoPromotion('skill', {})).toEqual({ mode: 'review', knob: null });
  });
});

describe('autoPromotionDecision (L-D1, L-D11)', () => {
  const skill = { kind: 'skill' as const, personalityId: PID };
  it('a shared-scope skill with a pass verdict under auto needs a human', () => {
    const d = autoPromotionDecision({
      candidate: skill,
      verdict: 'pass',
      mode: 'auto',
      scope: undefined,
    });
    expect(d.promote).toBe(false);
    expect(d.reason).toContain('shared skill');
  });
  it('a personality-scope skill with a pass verdict under auto promotes', () => {
    expect(
      autoPromotionDecision({
        candidate: skill,
        verdict: 'pass',
        mode: 'auto',
        scope: 'personality',
      }).promote,
    ).toBe(true);
  });
  it('anything but pass needs a human', () => {
    for (const verdict of ['regress', 'incomplete', null] as const) {
      expect(
        autoPromotionDecision({ candidate: skill, verdict, mode: 'auto', scope: 'personality' })
          .promote,
      ).toBe(false);
    }
  });
});

// --- replayAndResolve, end to end on InMemoryStorage -------------------------

let storage: InMemoryStorage;
let clock: number;
const now = () => {
  clock += 1000;
  return clock;
};

function frozen(id: string, frozenAt: string): LearningCase {
  return {
    id,
    personalityId: PID,
    prompt: `prompt ${id}`,
    context: [],
    assertions: [{ kind: 'contains', value: id === 'target' ? 'GOOD' : 'hello' }],
    source: 'eval',
    sourceRef: `eval:${id}`,
    frozenAt,
  };
}

/** Candidate says GOOD on the target; both arms say hello on the regressions → `pass`. */
function arms(regress = false): CreateReplayArm {
  return async ({ arm }) => ({
    loop: {
      async *run(_prompt, options): AsyncIterable<AgentEvent> {
        const caseId = options.sessionKey.split(':').at(-1);
        let text = 'hello';
        if (caseId === 'target') text = arm === 'candidate' ? 'GOOD' : 'weak';
        if (regress && arm === 'candidate' && caseId !== 'target') text = 'bye';
        yield { type: 'done', text, turnCount: 1 };
      },
    },
    dispose: async () => {},
  });
}

const unusedGrader: LLMProvider = {
  name: 'grader',
  model: 'grader',
  maxContextTokens: 8_192,
  supportsCaching: false,
  supportsThinking: false,
  // These cases carry no `criteria` assertion, so nothing should reach the
  // grader; if something does, it grades a fail rather than a pass.
  async *complete(): AsyncIterable<CompletionChunk> {
    yield { type: 'text_delta', text: '0' };
  },
  async countTokens() {
    return 0;
  },
};

function deps(opts: {
  knobs: AutoPromotionKnobs;
  scope: SkillScope | undefined;
  regress?: boolean;
  evolveExpression?: ExpressionRevisions['evolveExpression'];
  observability?: LearningObservability;
}): ReplayAndResolveDeps {
  return {
    storage,
    dataDir: DATA,
    createArm: arms(opts.regress),
    newSession: () => new InMemorySessionStore(),
    grader: unusedGrader,
    runOptions: { dryRun: true, temperature: 0 },
    settings: { maxCases: 8, maxCostUsd: 0.5 },
    shadowFor: async (c) => ({ path: c.destination, content: c.content }),
    now,
    promote: {
      storage,
      dataDir: DATA,
      liveSkillDir,
      skillScope: () => opts.scope,
      checkSkillFrontmatter,
      vetSkill: vetPromotedSkill,
      expressions: {
        evolveExpression:
          opts.evolveExpression ??
          (async () => {
            throw new Error('not expected');
          }),
        revertExpression: async () => undefined,
      },
      now,
    },
    policyFor: async () => ({ knobs: opts.knobs, scope: opts.scope }),
    actor: 'cli',
    ...(opts.observability ? { observability: opts.observability } : {}),
  };
}

async function seedCases(): Promise<string> {
  await freezeCase(storage, DATA, frozen('target', '2026-09-01T00:00:01.000Z'));
  await freezeCase(storage, DATA, frozen('reg-a', '2026-09-01T00:00:02.000Z'));
  await freezeCase(storage, DATA, frozen('reg-b', '2026-09-01T00:00:03.000Z'));
  return 'target';
}

beforeEach(() => {
  storage = new InMemoryStorage();
  clock = Date.parse('2026-09-13T00:00:00.000Z');
});

describe('replayAndResolve', () => {
  it('does NOT auto-promote a shared-scope skill with a pass verdict under auto', async () => {
    const target = await seedCases();
    const destination = join(liveSkillDir(DATA, PID, undefined), 'cite.md');
    const c = await submitCandidate(storage, DATA, {
      kind: 'skill',
      op: 'create',
      personalityId: PID,
      origin: 'fork',
      destination,
      content: SKILL,
      targetCaseIds: [target],
    });

    const result = await replayAndResolve(
      deps({ knobs: { globalAutoApprove: true }, scope: undefined }),
      c.id,
    );

    expect(result.report.verdict).toBe('pass');
    expect(result.decision.promote).toBe(false);
    expect(result.promotion).toBeNull();
    expect((await readCandidate(storage, DATA, c.id))?.status).toBe('pending_review');
    expect(await storage.exists(destination)).toBe(false);
  });

  it('auto-promotes a personality-scope skill with a pass verdict under auto', async () => {
    const target = await seedCases();
    const destination = join(liveSkillDir(DATA, PID, 'personality'), 'cite.md');
    const c = await submitCandidate(storage, DATA, {
      kind: 'skill',
      op: 'create',
      personalityId: PID,
      origin: 'fork',
      destination,
      content: SKILL,
      targetCaseIds: [target],
    });

    const result = await replayAndResolve(
      deps({ knobs: { globalAutoApprove: true }, scope: 'personality' }),
      c.id,
    );

    expect(result.promotion?.ok).toBe(true);
    expect((await readCandidate(storage, DATA, c.id))?.status).toBe('promoted');
    expect(await storage.read(destination)).toBe(SKILL);
  });

  it('does not auto-promote on a regress verdict, even personality-scoped under auto', async () => {
    const target = await seedCases();
    const destination = join(liveSkillDir(DATA, PID, 'personality'), 'cite.md');
    const c = await submitCandidate(storage, DATA, {
      kind: 'skill',
      op: 'create',
      personalityId: PID,
      origin: 'nightly',
      destination,
      content: SKILL,
      targetCaseIds: [target],
    });

    const result = await replayAndResolve(
      deps({ knobs: { promotion: 'auto' }, scope: 'personality', regress: true }),
      c.id,
    );

    expect(result.report.verdict).toBe('regress');
    expect(result.promotion).toBeNull();
    expect(await storage.exists(destination)).toBe(false);
  });

  it('a user-mode Expression candidate never reaches evolveExpression, even on pass', async () => {
    const target = await seedCases();
    const soul = join(DATA, 'personalities', PID, 'SOUL.md');
    await storage.mkdir(join(DATA, 'personalities', PID));
    await storage.write(soul, 'soul bytes');
    const c = await submitCandidate(storage, DATA, {
      kind: 'expression',
      op: 'update',
      personalityId: PID,
      origin: 'nightly',
      destination: soul,
      content: 'new expression',
      targetCaseIds: [target],
    });
    const evolveExpression = vi.fn<ExpressionRevisions['evolveExpression']>();

    const result = await replayAndResolve(
      deps({
        knobs: { approvalMode: 'user', globalAutoApprove: true },
        scope: 'personality',
        evolveExpression,
      }),
      c.id,
    );

    expect(result.report.verdict).toBe('pass');
    expect(result.promotion).toBeNull();
    expect(evolveExpression).not.toHaveBeenCalled();
    expect((await readCandidate(storage, DATA, c.id))?.status).toBe('pending_review');
  });
});

type AuditRow = Parameters<LearningObservability['recordSafetyApproval']>[0];

describe('replayAndResolve — the learning.auto_promote audit row', () => {
  let rows: AuditRow[];
  const observability: LearningObservability = { recordSafetyApproval: (row) => rows.push(row) };
  beforeEach(() => {
    rows = [];
  });

  async function submitSkill(scope: SkillScope | undefined, origin: 'fork' | 'nightly' = 'fork') {
    const target = await seedCases();
    const destination = join(liveSkillDir(DATA, PID, scope), 'cite.md');
    const c = await submitCandidate(storage, DATA, {
      kind: 'skill',
      op: 'create',
      personalityId: PID,
      origin,
      destination,
      content: SKILL,
      targetCaseIds: [target],
    });
    return { c, destination };
  }

  it('an automatic promotion writes exactly one learning.auto_promote row with the verdict and the reason', async () => {
    const { c, destination } = await submitSkill('personality');

    const result = await replayAndResolve(
      deps({ knobs: { globalAutoApprove: true }, scope: 'personality', observability }),
      c.id,
    );

    expect(result.promotion?.ok).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      decision: 'auto',
      code: LEARNING_AUTO_PROMOTE_CODE,
      details: {
        candidateId: c.id,
        personalityId: PID,
        kind: 'skill',
        destination,
        status: 'promoted',
        actor: 'auto',
        decidedBy: 'system',
        trigger: 'cli',
        verdict: 'pass',
        replayRunId: result.report.runId,
        knob: 'autoApprove',
        scope: 'personality',
      },
    });
    const reason = String(rows[0]?.details?.reason);
    expect(reason).toContain('autoApprove resolved auto');
    expect(reason).toContain('skill_evolution.scope: personality');
    expect(rows[0]?.cause).toContain(reason);
    // The hash, never the content.
    expect(JSON.stringify(rows[0])).not.toContain('Cite every claim.');
  });

  it('a replay that does not promote writes none', async () => {
    const shared = await submitSkill(undefined);
    await replayAndResolve(
      deps({ knobs: { globalAutoApprove: true }, scope: undefined, observability }),
      shared.c.id,
    );
    const review = await submitSkill('personality', 'nightly');
    await replayAndResolve(
      deps({ knobs: { promotion: 'review' }, scope: 'personality', observability }),
      review.c.id,
    );
    const regress = await submitSkill('personality', 'nightly');
    await replayAndResolve(
      deps({ knobs: { promotion: 'auto' }, scope: 'personality', regress: true, observability }),
      regress.c.id,
    );

    expect(rows).toEqual([]);
  });

  it('a promotion promote() refuses writes none', async () => {
    const { c, destination } = await submitSkill('personality');
    // A file appeared at the destination after the draft: the candidate is stale.
    await storage.mkdir(liveSkillDir(DATA, PID, 'personality'));
    await storage.write(destination, 'someone else wrote this');

    const result = await replayAndResolve(
      deps({ knobs: { promotion: 'auto' }, scope: 'personality', observability }),
      c.id,
    );

    expect(result.decision.promote).toBe(true);
    expect(result.promotion).toMatchObject({ ok: false, code: 'stale' });
    expect(rows).toEqual([]);
  });

  it('a sink that throws does not undo the promotion', async () => {
    const { c, destination } = await submitSkill('personality');
    const broken: LearningObservability = {
      recordSafetyApproval: () => {
        throw new Error('store down');
      },
    };

    const result = await replayAndResolve(
      deps({ knobs: { promotion: 'auto' }, scope: 'personality', observability: broken }),
      c.id,
    );

    expect(result.promotion?.ok).toBe(true);
    expect(await storage.read(destination)).toBe(SKILL);
  });
});
