import { join } from 'node:path';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { createLearningInbox } from '@ethosagent/wiring';
import { beforeEach, describe, expect, it } from 'vitest';
// Relative on purpose: web-api reaches the inbox through `@ethosagent/wiring`
// and has no workspace link to the package; the test seeds the real store.
import {
  submitCandidate,
  updateCandidate,
} from '../../../../../extensions/learning-inbox/src/store';
import type { ApprovalObservability } from '../../services/approvals.service';
import { LearningService } from '../../services/learning.service';

// L-T8 — the web half of the learning review inbox.
//
// The inbox's own rules are covered in `extensions/learning-inbox/src/__tests__/
// inbox.test.ts`; what is under test here is the SERVICE boundary as the web
// sees it: wire views, the override rule reaching the web path, exactly one
// `ethos audit decisions` row per decision, and the legacy drain on first use.

const DATA = '/ethos';
const LIVE = join(DATA, 'skills');
const SKILL = '---\nname: cite-sources\ndescription: "Always cite"\n---\n\nCite every claim.\n';

type AuditRow = Parameters<ApprovalObservability['recordSafetyApproval']>[0];

let storage: InMemoryStorage;
let rows: AuditRow[];
let service: LearningService;

beforeEach(async () => {
  storage = new InMemoryStorage();
  rows = [];
  const dir = join(DATA, 'personalities', 'agent');
  await storage.mkdir(dir);
  await storage.write(join(dir, 'config.yaml'), 'name: Agent\n');
  await storage.write(join(dir, 'SOUL.md'), '# Core\nI am the agent.\n\n# Expression\nPlain.\n');
  const registry = new FilePersonalityRegistry(storage, DATA);
  await registry.loadFromDirectory(join(DATA, 'personalities'));
  service = new LearningService({
    inbox: createLearningInbox({
      storage,
      dataDir: DATA,
      personalities: registry,
      expressions: registry,
      defaultPersonalityId: 'agent',
      observability: { recordSafetyApproval: (row) => rows.push(row) },
    }),
  });
});

async function submitSkill(fileName = 'cite-sources.md') {
  return submitCandidate(storage, DATA, {
    kind: 'skill',
    op: 'create',
    personalityId: 'agent',
    origin: 'nightly',
    destination: join(LIVE, fileName),
    content: SKILL,
  });
}

async function markPassed(id: string) {
  await updateCandidate(storage, DATA, id, { status: 'pending_review', verdict: 'pass' });
}

describe('LearningService', () => {
  it('list returns wire views, filtered by status', async () => {
    const waiting = await submitSkill('a.md');
    const decided = await submitSkill('b.md');
    await service.reject({ candidateId: decided.id, decidedBy: 'tab' });

    const all = await service.list();
    expect(all.candidates.map((c) => c.id).sort()).toEqual([waiting.id, decided.id].sort());
    expect(all.candidates.find((c) => c.id === waiting.id)).toMatchObject({
      kind: 'skill',
      origin: 'nightly',
      status: 'pending_replay',
      verdict: null,
      evidence: { sessionIds: [], taskIds: [], digest: null, ref: null },
    });

    const pending = await service.list({ statuses: ['pending_replay', 'pending_review'] });
    expect(pending.candidates.map((c) => c.id)).toEqual([waiting.id]);
  });

  it('approve without an override on a non-pass verdict is refused and writes no audit row', async () => {
    const candidate = await submitSkill();
    await updateCandidate(storage, DATA, candidate.id, {
      status: 'pending_review',
      verdict: 'regress',
    });

    const result = await service.approve({ candidateId: candidate.id, decidedBy: 'tab' });

    expect(result).toMatchObject({ ok: false, code: 'override_required' });
    expect(await storage.exists(join(LIVE, 'cite-sources.md'))).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it('approve on a never-replayed candidate requires an override', async () => {
    const candidate = await submitSkill();
    const result = await service.approve({ candidateId: candidate.id, decidedBy: 'tab' });
    expect(result).toMatchObject({ ok: false, code: 'override_required' });
    expect(rows).toHaveLength(0);
  });

  it('approve with an override promotes and writes exactly one learning.override audit row', async () => {
    const candidate = await submitSkill();
    const result = await service.approve({
      candidateId: candidate.id,
      decidedBy: 'tab-7',
      override: { reason: 'read it myself' },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        candidate: { status: 'promoted' },
        promotion: { destination: join(LIVE, 'cite-sources.md') },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      code: 'learning.override',
      decision: 'approved',
      details: { decidedBy: 'tab-7', overrideReason: 'read it myself' },
    });
  });

  it('approve on a pass writes exactly one learning.approve audit row', async () => {
    const candidate = await submitSkill();
    await markPassed(candidate.id);
    const result = await service.approve({ candidateId: candidate.id, decidedBy: 'tab' });
    expect(result.ok).toBe(true);
    expect(rows.map((r) => r.code)).toEqual(['learning.approve']);
  });

  it('reject writes exactly one learning.reject audit row', async () => {
    const candidate = await submitSkill();
    const result = await service.reject({
      candidateId: candidate.id,
      decidedBy: 'tab',
      reason: 'not useful',
    });
    expect(result).toMatchObject({ ok: true, value: { candidate: { status: 'rejected' } } });
    expect(rows.map((r) => r.code)).toEqual(['learning.reject']);
  });

  it('rollback restores the live state and writes exactly one learning.rollback audit row', async () => {
    const candidate = await submitSkill();
    await markPassed(candidate.id);
    await service.approve({ candidateId: candidate.id, decidedBy: 'tab' });
    rows.length = 0;

    const detail = await service.get(candidate.id);
    expect(detail).toMatchObject({ ok: true, value: { rollback: { allowed: true } } });

    const result = await service.rollback({ candidateId: candidate.id, decidedBy: 'tab' });
    expect(result).toMatchObject({ ok: true, value: { candidate: { status: 'rolled_back' } } });
    expect(await storage.exists(join(LIVE, 'cite-sources.md'))).toBe(false);
    expect(rows.map((r) => r.code)).toEqual(['learning.rollback']);
  });

  it('get reports a disabled rollback with its reason when the live file was edited', async () => {
    const candidate = await submitSkill();
    await markPassed(candidate.id);
    await service.approve({ candidateId: candidate.id, decidedBy: 'tab' });
    await storage.write(join(LIVE, 'cite-sources.md'), 'hand edit\n');

    const detail = await service.get(candidate.id);
    expect(detail).toMatchObject({
      ok: true,
      value: { rollback: { allowed: false, code: 'live_edited' }, replay: null },
    });
  });

  it('replay is refused as replay_unavailable when this server has no replayer', async () => {
    const candidate = await submitSkill();
    expect(await service.replay(candidate.id)).toMatchObject({
      ok: false,
      code: 'replay_unavailable',
    });
  });

  it('drains the legacy pending queues on first use, so a web-only deployment is not empty', async () => {
    const legacy = join(DATA, 'skills', '.pending', 'agent');
    await storage.mkdir(legacy);
    await storage.write(join(legacy, 'nightly-a.md'), SKILL);

    const { candidates } = await service.list();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ origin: 'legacy', personalityId: 'agent' });
    expect(await storage.exists(join(legacy, 'nightly-a.md'))).toBe(false);
  });
});
