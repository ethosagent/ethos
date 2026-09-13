// `ethos nightly` says why nothing was frozen when pinned target cases hold the
// learning case pool over its cap. The pool here is real — cases frozen and
// candidates submitted through `@ethosagent/learning-inbox` — and the line
// checked is the one `runNightlyOnce` prints (`nightlyStepLine`).

import { join } from 'node:path';
import {
  CASE_POOL_CAP,
  freezeCase,
  type LearningCase,
  submitCandidate,
  updateCandidate,
} from '@ethosagent/learning-inbox';
import { type NightlyPassDeps, runNightlyPass } from '@ethosagent/nightly-loop';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { PersonalityConfig } from '@ethosagent/types';
import { freezeNightlyCases } from '@ethosagent/wiring';
import { beforeEach, describe, expect, it } from 'vitest';
import { nightlyCaseFreeze, nightlyStepLine } from '../nightly';

const DATA = '/ethos';
const PID = 'researcher';

let storage: InMemoryStorage;
const configs: Record<string, PersonalityConfig> = {
  [PID]: {
    id: PID,
    name: 'Researcher',
    soulFile: join(DATA, 'personalities', PID, 'SOUL.md'),
  },
};
const personalities = { get: (id: string) => configs[id] };

function caseAt(n: number): LearningCase {
  return {
    id: `case${String(n).padStart(3, '0')}`,
    personalityId: PID,
    prompt: `p${n}`,
    context: [],
    assertions: [{ kind: 'criteria', value: 'good' }],
    source: 'session',
    sourceRef: `session:old${n}`,
    frozenAt: new Date(Date.UTC(2026, 7, 1, 0, 0, n)).toISOString(),
  };
}

async function pendingCandidateWith(targetCaseIds: string[]): Promise<void> {
  const candidate = await submitCandidate(storage, DATA, {
    kind: 'skill',
    op: 'create',
    personalityId: PID,
    origin: 'nightly',
    destination: join(DATA, 'personalities', PID, 'skills', 'cite.md'),
    content: '---\nname: cite\n---\n',
    targetCaseIds,
  });
  await updateCandidate(storage, DATA, candidate.id, { status: 'pending_review' });
}

function depsWith(learning: NightlyPassDeps['learning']): NightlyPassDeps {
  const gatedOff = async (): Promise<never> => {
    throw new Error('gated off in this test');
  };
  return {
    readLivingSoul: async () => ({ core: 'I am careful.', expression: 'I speak plainly.' }),
    gatherEvidence: async () => ({
      recentPrompts: [],
      evidenceDigest: '',
      windowStart: '2026-09-12T00:00:00.000Z',
      windowEnd: '2026-09-13T00:00:00.000Z',
      elapsedHours: 24,
    }),
    scoreAlignment: gatedOff,
    readJudgeStreak: async () => 0,
    writeJudgeStreak: async () => {},
    draftExpression: gatedOff,
    submitExpression: gatedOff,
    learning,
    readMemory: async () => ({ memory: '', user: '' }),
    consolidate: async () => ({ memory: '', user: '' }),
    applyMemoryUpdates: async () => {},
    readState: async () => null,
    writeState: async () => {},
  };
}

beforeEach(async () => {
  storage = new InMemoryStorage();
  await storage.mkdir(join(DATA, 'personalities', PID));
  await storage.write(join(DATA, 'personalities', PID, 'SOUL.md'), '# Core\nI am careful.\n');
});

describe('ethos nightly — case pool overflow', () => {
  it('prints the overflow and the pinned count when pinned targets exceed the cap', async () => {
    const total = CASE_POOL_CAP + 3;
    for (let n = 0; n < total; n += 1) await freezeCase(storage, DATA, caseAt(n));
    const ids = Array.from({ length: total }, (_, n) => caseAt(n).id);
    await pendingCandidateWith(ids.slice(0, 20));
    await pendingCandidateWith(ids.slice(20));
    const ctx = { storage, dataDir: DATA, personalities };

    const result = await runNightlyPass(
      PID,
      depsWith({
        enabled: true,
        budget: { take: () => true },
        freezeCases: async (id) =>
          nightlyCaseFreeze(await freezeNightlyCases(ctx, { personalityId: id })),
        pendingReplay: async () => [],
        replay: async () => ({ verdict: 'incomplete', promoted: false }),
      }),
      { judge: false, expression: false },
    );

    const replay = result.steps.find((s) => s.step === 'replay');
    expect(replay).toBeDefined();
    const line = replay ? nightlyStepLine(replay) : '';
    expect(line).toContain('0 case(s) frozen');
    expect(line).toContain(
      'case pool is 3 over its cap: 43 case(s) are targets of undecided candidates',
    );
    expect(line).toContain('approving or rejecting pending candidates frees the pool');
  });
});
