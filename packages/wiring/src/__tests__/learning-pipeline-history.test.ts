// Plan skill-history-and-lock: `learningPromoteDeps` binds `SkillHistory` as the one
// writer of live skills and the one lock check. Kept beside, not inside,
// `learning-pipeline.test.ts`, which is at its size baseline.

import { join } from 'node:path';
import { rollback, submitCandidate } from '@ethosagent/learning-inbox';
import { SkillHistory } from '@ethosagent/skills';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { learningPromoteDeps, promoteLearningCandidate } from '../learning-pipeline';

const DATA = '/ethos';
let storage: InMemoryStorage;
const personalities = { get: (_id: string) => undefined };

beforeEach(() => {
  storage = new InMemoryStorage();
});

describe('learningPromoteDeps binds the skill history (plan skill-history-and-lock)', () => {
  const unused = async (): Promise<never> => {
    throw new Error('unused');
  };
  const ctx = () => ({
    storage,
    dataDir: DATA,
    personalities,
    expressions: { evolveExpression: unused, revertExpression: unused },
    observability: { recordSafetyApproval: () => {} },
  });
  const content = '---\nname: cite\ndescription: "Cite"\n---\n\nCite.\n';
  const dest = join(DATA, 'skills', 'cite.md');

  it('a human approval records a learning version, and rollback a learning-rollback one', async () => {
    const c = await submitCandidate(storage, DATA, {
      kind: 'skill',
      op: 'create',
      personalityId: 'scout',
      origin: 'nightly',
      destination: dest,
      content,
    });
    const history = new SkillHistory({ storage, dataDir: DATA });

    expect((await promoteLearningCandidate(ctx(), c.id, { actor: 'web' })).ok).toBe(true);
    expect((await history.versions(dest)).map((r) => r.source)).toEqual(['learning']);
    expect(await rollback(learningPromoteDeps(ctx()), c.id, { actor: 'web' })).toMatchObject({
      ok: true,
    });
    expect((await history.versions(dest)).map((r) => r.source)).toEqual([
      'learning',
      'learning-rollback',
    ]);
  });

  it('a locked skill refuses an approval with code locked and writes nothing', async () => {
    const c = await submitCandidate(storage, DATA, {
      kind: 'skill',
      op: 'create',
      personalityId: 'scout',
      origin: 'nightly',
      destination: dest,
      content,
    });
    await new SkillHistory({ storage, dataDir: DATA }).setLock(dest, true, 'cli');

    const result = await promoteLearningCandidate(ctx(), c.id, { actor: 'web' });

    expect(result).toMatchObject({ ok: false, code: 'locked' });
    expect(await storage.exists(dest)).toBe(false);
  });
});
