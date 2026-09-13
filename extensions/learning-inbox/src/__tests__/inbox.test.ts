// L-T8 — `LearningInbox`: the override rule and one audit row per human
// decision, on InMemoryStorage with the REAL promote gates.

import { join } from 'node:path';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { liveSkillDir } from '@ethosagent/skill-evolver';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// Relative on purpose — see `promote.test.ts`: the test exercises the real gate.
import { checkSkillFrontmatter } from '../../../skills/src/skill-compat';
import { readAudit } from '../audit';
import type { ReplayAndResolveResult } from '../auto-promotion';
import { LEARNING_AUDIT_CODES, LearningInbox, type LearningObservability } from '../inbox';
import type { PromoteDeps } from '../promote';
import { REPLAY_LIMITATIONS, type ReplayReport } from '../replay';
import {
  readCandidate,
  type SubmitCandidateInput,
  submitCandidate,
  updateCandidate,
  writeReplayRun,
} from '../store';

const DATA = '/ethos';
const LIVE = join(DATA, 'skills');
const GOOD_SKILL =
  '---\nname: cite-sources\ndescription: "Always cite"\n---\n\nCite every claim.\n';

type AuditRow = Parameters<LearningObservability['recordSafetyApproval']>[0];

let storage: InMemoryStorage;
let rows: AuditRow[];
let clock: number;
const now = () => {
  clock += 1000;
  return clock;
};

function promoteDeps(): PromoteDeps {
  return {
    storage,
    dataDir: DATA,
    liveSkillDir,
    skillScope: () => undefined,
    checkSkillFrontmatter,
    expressions: new FilePersonalityRegistry(storage, DATA),
    now,
  };
}

function inbox(extra: Partial<ConstructorParameters<typeof LearningInbox>[0]> = {}) {
  return new LearningInbox({
    storage,
    dataDir: DATA,
    promote: promoteDeps(),
    observability: { recordSafetyApproval: (row) => rows.push(row) },
    ...extra,
  });
}

async function submitSkill(input: Partial<SubmitCandidateInput> = {}) {
  return submitCandidate(
    storage,
    DATA,
    {
      kind: 'skill',
      op: 'create',
      personalityId: 'scout',
      origin: 'nightly',
      destination: join(LIVE, 'cite-sources.md'),
      content: GOOD_SKILL,
      ...input,
    },
    now,
  );
}

async function withVerdict(id: string, verdict: 'pass' | 'regress' | 'incomplete') {
  await updateCandidate(storage, DATA, id, { status: 'pending_review', verdict }, now);
}

beforeEach(() => {
  storage = new InMemoryStorage();
  rows = [];
  clock = Date.parse('2026-09-13T00:00:00.000Z');
});

describe('LEARNING_AUDIT_CODES', () => {
  it('the human decision codes are unchanged; the automatic promotion code is not one of them', () => {
    expect(LEARNING_AUDIT_CODES).toEqual({
      approve: 'learning.approve',
      override: 'learning.override',
      reject: 'learning.reject',
      rollback: 'learning.rollback',
    });
    expect(Object.values(LEARNING_AUDIT_CODES)).not.toContain('learning.auto_promote');
  });
});

describe('LearningInbox.approve — the override rule', () => {
  it('refuses a never-replayed candidate without an override, and changes nothing', async () => {
    const candidate = await submitSkill();
    const result = await inbox().approve(candidate.id, { actor: 'cli', decidedBy: 'test' });

    expect(result).toMatchObject({ ok: false, code: 'override_required' });
    expect(await storage.exists(join(LIVE, 'cite-sources.md'))).toBe(false);
    expect((await readCandidate(storage, DATA, candidate.id))?.status).toBe('pending_replay');
    expect(rows).toEqual([]);
  });

  it.each(['regress', 'incomplete'] as const)(
    'refuses a %s verdict without an override',
    async (verdict) => {
      const candidate = await submitSkill();
      await withVerdict(candidate.id, verdict);
      const result = await inbox().approve(candidate.id, { actor: 'cli', decidedBy: 'test' });
      expect(result).toMatchObject({ ok: false, code: 'override_required' });
      expect(rows).toEqual([]);
    },
  );

  it('a blank override reason is no reason', async () => {
    const candidate = await submitSkill();
    const result = await inbox().approve(candidate.id, {
      actor: 'cli',
      decidedBy: 'test',
      override: { reason: '   ' },
    });
    expect(result).toMatchObject({ ok: false, code: 'override_required' });
  });

  it('an override promotes, writes ONE learning.override row, and puts the reason in audit.jsonl', async () => {
    const candidate = await submitSkill();
    const result = await inbox().approve(candidate.id, {
      actor: 'web',
      decidedBy: 'tab-1',
      override: { reason: 'reviewed by hand; replay budget exhausted' },
    });

    expect(result.ok).toBe(true);
    expect(await storage.read(join(LIVE, 'cite-sources.md'))).toBe(GOOD_SKILL);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      decision: 'approved',
      severity: 'warn',
      code: LEARNING_AUDIT_CODES.override,
      details: {
        candidateId: candidate.id,
        decidedBy: 'tab-1',
        actor: 'web',
        verdict: null,
        overrideReason: 'reviewed by hand; replay budget exhausted',
      },
    });
    const timeline = await readAudit(storage, DATA, { candidateId: candidate.id });
    expect(timeline.at(-1)).toMatchObject({ to: 'promoted', actor: 'web' });
    expect(timeline.at(-1)?.reason).toContain('reviewed by hand; replay budget exhausted');
  });

  it('a pass needs no override and writes ONE learning.approve row', async () => {
    const candidate = await submitSkill();
    await withVerdict(candidate.id, 'pass');
    const result = await inbox().approve(candidate.id, { actor: 'cli', decidedBy: 'test' });

    expect(result.ok).toBe(true);
    expect(rows.map((r) => r.code)).toEqual([LEARNING_AUDIT_CODES.approve]);
    expect(rows[0]?.decision).toBe('approved');
  });

  it('a promote refusal (bad frontmatter) is returned and writes no row', async () => {
    const candidate = await submitSkill({ content: '---\nname: x\ndescription: a: b\n---\n' });
    await withVerdict(candidate.id, 'pass');
    const result = await inbox().approve(candidate.id, { actor: 'cli', decidedBy: 'test' });

    expect(result).toMatchObject({ ok: false, code: 'invalid' });
    expect(rows).toEqual([]);
  });

  it('refuses an already-decided candidate as not_promotable', async () => {
    const candidate = await submitSkill();
    await inbox().reject(candidate.id, { actor: 'cli', decidedBy: 'test' });
    rows = [];
    const result = await inbox().approve(candidate.id, {
      actor: 'cli',
      decidedBy: 'test',
      override: { reason: 'x' },
    });
    expect(result).toMatchObject({ ok: false, code: 'not_promotable' });
    expect(rows).toEqual([]);
  });
});

describe('LearningInbox.reject / rollback', () => {
  it('reject writes ONE learning.reject row', async () => {
    const candidate = await submitSkill();
    const result = await inbox().reject(candidate.id, {
      actor: 'chat',
      decidedBy: 'chat',
      reason: 'duplicate',
    });

    expect(result).toMatchObject({ ok: true, value: { status: 'rejected' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      code: LEARNING_AUDIT_CODES.reject,
      decision: 'denied',
      details: { reason: 'duplicate' },
    });
  });

  it('rollback writes ONE learning.rollback row and restores the prior state', async () => {
    const candidate = await submitSkill();
    await withVerdict(candidate.id, 'pass');
    const box = inbox();
    await box.approve(candidate.id, { actor: 'cli', decidedBy: 'test' });
    rows = [];

    const result = await box.rollback(candidate.id, { actor: 'cli', decidedBy: 'test' });

    expect(result).toMatchObject({ ok: true, value: { status: 'rolled_back' } });
    expect(await storage.exists(join(LIVE, 'cite-sources.md'))).toBe(false);
    expect(rows.map((r) => r.code)).toEqual([LEARNING_AUDIT_CODES.rollback]);
  });

  it('a refused rollback (live file edited since) writes no row', async () => {
    const candidate = await submitSkill();
    await withVerdict(candidate.id, 'pass');
    const box = inbox();
    await box.approve(candidate.id, { actor: 'cli', decidedBy: 'test' });
    await storage.write(join(LIVE, 'cite-sources.md'), `${GOOD_SKILL}\nhand edit\n`);
    rows = [];

    const result = await box.rollback(candidate.id, { actor: 'cli', decidedBy: 'test' });
    expect(result).toMatchObject({ ok: false, code: 'live_edited' });
    expect(rows).toEqual([]);
  });
});

describe('LearningInbox.get / resolve / replay / list', () => {
  it('get carries the newest scorecard, the timeline and the rollback check', async () => {
    const candidate = await submitSkill();
    const report: ReplayReport = {
      runId: 'r-1',
      candidateId: candidate.id,
      testedOn: 'scout',
      startedAt: '2026-09-13T00:00:00.000Z',
      finishedAt: '2026-09-13T00:01:00.000Z',
      verdict: 'incomplete',
      rules: { a: false, b: true, c: false, d: true },
      targetMeanDelta: null,
      regressionMeanDelta: null,
      regressionsWorse: 0,
      regressionCount: 0,
      costUsd: 0,
      maxCostUsd: 0.5,
      stopReason: 'insufficient_cases',
      error: null,
      cases: [],
      skipped: [],
      limitations: REPLAY_LIMITATIONS,
    };
    await writeReplayRun(storage, DATA, candidate.id, 'r-1', report, now);

    const result = await inbox().get(candidate.id);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.replay?.runId).toBe('r-1');
    expect(result.value.replay?.limitations).toEqual(REPLAY_LIMITATIONS);
    expect(result.value.timeline.map((e) => e.action)).toEqual(['submitted', 'replay']);
    expect(result.value.current).toEqual({ content: null, core: null });
    expect(result.value.rollback).toMatchObject({ allowed: false, code: 'not_promoted' });
  });

  it('resolve finds a waiting candidate by destination filename, and refuses to guess between two', async () => {
    const one = await submitSkill();
    expect(await inbox().resolve('cite-sources.md', { kind: 'skill' })).toMatchObject({
      ok: true,
      value: { id: one.id },
    });
    await submitSkill({ personalityId: 'researcher' });
    expect(await inbox().resolve('cite-sources.md', { kind: 'skill' })).toMatchObject({
      ok: false,
      code: 'ambiguous',
    });
    expect(await inbox().resolve('nope.md', { kind: 'skill' })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('replay refuses when no replayer is wired, and delegates when one is', async () => {
    const candidate = await submitSkill();
    expect(await inbox().replay(candidate.id)).toMatchObject({
      ok: false,
      code: 'replay_unavailable',
    });

    const replay = vi.fn(async () => ({}) as unknown as ReplayAndResolveResult);
    expect((await inbox({ replay }).replay(candidate.id)).ok).toBe(true);
    expect(replay).toHaveBeenCalledWith(candidate.id);
  });

  it('runs the legacy import once, on first use, and retries after a failure', async () => {
    const importLegacy = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('disk hiccup'))
      .mockResolvedValue(undefined);
    const box = inbox({ importLegacy });

    await expect(box.list()).rejects.toThrow('disk hiccup');
    await box.list();
    await box.list();
    expect(importLegacy).toHaveBeenCalledTimes(2);
  });
});
