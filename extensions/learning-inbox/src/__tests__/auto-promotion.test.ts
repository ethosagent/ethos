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
import { checkSkillFrontmatter } from '../../../skills/src/skill-compat';
import {
  type AutoPromotionKnobs,
  autoPromotionDecision,
  type ReplayAndResolveDeps,
  replayAndResolve,
  resolveAutoPromotion,
} from '../auto-promotion';
import { freezeCase, type LearningCase } from '../cases';
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
