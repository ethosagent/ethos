// L-T6, path 4 — `ethos personality evolve` submits a CLI-origin candidate, and
// the human's y/N decides it THROUGH THE LEARNING INBOX (`LearningInbox`), the
// one owner of the override rule and of the `learning.*` audit row per
// decision. The interactive command is a thin shell over
// `submitExpressionCandidate` and `decideExpressionCandidate`, which is what is
// exercised here, against the real inbox `createLearningInbox` builds.

import { join } from 'node:path';
import {
  LEARNING_AUDIT_CODES,
  type LearningObservability,
  listCandidates,
  readPromotionRecord,
} from '@ethosagent/learning-inbox';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { createLearningInbox, submitExpressionCandidate } from '@ethosagent/wiring';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decideExpressionCandidate } from '../personality-evolve';

const DATA = '/ethos';

type AuditRow = Parameters<LearningObservability['recordSafetyApproval']>[0];

let storage: InMemoryStorage;
let reg: FilePersonalityRegistry;
let rows: AuditRow[];

beforeEach(async () => {
  storage = new InMemoryStorage();
  rows = [];
  const dir = join(DATA, 'personalities', 'sage');
  await storage.mkdir(dir);
  await storage.write(join(dir, 'config.yaml'), 'name: Sage\n');
  await storage.write(
    join(dir, 'SOUL.md'),
    '# Core\nI am wise.\n\n# Expression\nI speak slowly.\n',
  );
  reg = new FilePersonalityRegistry(storage, DATA);
  await reg.loadFromDirectory(join(DATA, 'personalities'));
});

function inbox() {
  return createLearningInbox({
    storage,
    dataDir: DATA,
    personalities: reg,
    expressions: reg,
    defaultPersonalityId: 'sage',
    observability: { recordSafetyApproval: (row) => rows.push(row) },
  });
}

async function submit() {
  return submitExpressionCandidate(
    { storage, dataDir: DATA, personalities: reg },
    {
      personalityId: 'sage',
      origin: 'cli',
      newExpression: 'I speak plainly.\n',
      rationale: 'evidence shows brevity lands',
      evidenceRef: 'sessions:test',
    },
  );
}

describe('ethos personality evolve (L-T6, path 4: cli)', () => {
  it('submits a cli-origin Expression candidate against the live SOUL.md', async () => {
    const candidate = await submit();

    expect(candidate).toMatchObject({
      kind: 'expression',
      op: 'update',
      origin: 'cli',
      personalityId: 'sage',
      status: 'pending_replay',
      destination: join(DATA, 'personalities', 'sage', 'SOUL.md'),
    });
    expect(candidate.baseHash).not.toBeNull();
    expect((await reg.readLivingSoul('sage')).expression).toContain('I speak slowly.');
  });

  it('`y` + a reason approves through the inbox and writes exactly one audit row', async () => {
    const candidate = await submit();
    const askReason = vi.fn(async () => 'read the diff myself; brevity is right');

    const decided = await decideExpressionCandidate({
      inbox: inbox(),
      candidate,
      approved: true,
      askReason,
    });

    expect(askReason).toHaveBeenCalledTimes(1);
    expect(decided.outcome).toBe('applied');
    expect((await reg.readLivingSoul('sage')).expression).toContain('I speak plainly.');
    const [stored] = await listCandidates(storage, DATA);
    expect(stored?.status).toBe('promoted');
    expect(await readPromotionRecord(storage, DATA, candidate.id)).toMatchObject({
      kind: 'expression',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      decision: 'approved',
      code: LEARNING_AUDIT_CODES.override,
      details: {
        candidateId: candidate.id,
        actor: 'cli',
        overrideReason: 'read the diff myself; brevity is right',
      },
    });
  });

  it('`y` + an empty reason approves nothing and writes nothing', async () => {
    const candidate = await submit();

    const decided = await decideExpressionCandidate({
      inbox: inbox(),
      candidate,
      approved: true,
      askReason: async () => '   ',
    });

    expect(decided.outcome).toBe('cancelled');
    expect(rows).toHaveLength(0);
    expect((await reg.readLivingSoul('sage')).expression).toContain('I speak slowly.');
    expect((await listCandidates(storage, DATA))[0]?.status).toBe('pending_replay');
    expect(await readPromotionRecord(storage, DATA, candidate.id)).toBeNull();
  });

  it('`N` rejects through the inbox, writes one audit row, and never asks for a reason', async () => {
    const candidate = await submit();
    const askReason = vi.fn(async () => 'unused');

    const decided = await decideExpressionCandidate({
      inbox: inbox(),
      candidate,
      approved: false,
      askReason,
    });

    expect(decided.outcome).toBe('declined');
    expect(askReason).not.toHaveBeenCalled();
    expect((await listCandidates(storage, DATA))[0]?.status).toBe('rejected');
    expect((await reg.readLivingSoul('sage')).expression).toContain('I speak slowly.');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: 'denied', code: LEARNING_AUDIT_CODES.reject });
  });
});
