// L-T1 — the candidate store, its audit log, and the one-time legacy drain.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { readAudit } from '../audit';
import { hasImportedLegacy, importLegacyQueues, readTargetFile } from '../import-legacy';
import { candidatePath, legacyImportMarkerPath } from '../paths';
import {
  listCandidates,
  listReplayRunIds,
  readCandidate,
  readReplayRun,
  sha256Hex,
  submitCandidate,
  updateCandidate,
  writeReplayRun,
} from '../store';

const DATA = '/ethos';

let storage: InMemoryStorage;
let clock: number;
const now = () => {
  clock += 1000;
  return clock;
};

beforeEach(() => {
  storage = new InMemoryStorage();
  clock = Date.parse('2026-09-12T00:00:00.000Z');
});

async function seed(path: string, content: string): Promise<void> {
  await storage.mkdir(path.slice(0, path.lastIndexOf('/')));
  await storage.write(path, content);
}

describe('candidate round trip', () => {
  it('stores, reads back, lists, and records every transition', async () => {
    await seed('/ethos/skills/summarise.md', 'live bytes');

    const submitted = await submitCandidate(
      storage,
      DATA,
      {
        kind: 'skill',
        op: 'rewrite',
        personalityId: 'researcher',
        origin: 'nightly',
        destination: '/ethos/skills/summarise.md',
        content: '# better summarise',
        evidence: { sessionIds: ['s1'], taskIds: ['t1'], digest: 'three retries in a row' },
        targetCaseIds: ['case-a'],
      },
      now,
    );

    expect(submitted.status).toBe('pending_replay');
    expect(submitted.verdict).toBeNull();
    expect(submitted.baseHash).toBe(sha256Hex('live bytes'));
    expect(submitted.evidence.sessionIds).toEqual(['s1']);

    const read = await readCandidate(storage, DATA, submitted.id);
    expect(read).toEqual(submitted);

    // The file is where the plan says it is.
    expect(await storage.exists(candidatePath(DATA, submitted.id))).toBe(true);

    const scored = await updateCandidate(
      storage,
      DATA,
      submitted.id,
      { status: 'pending_review', verdict: 'pass', actor: 'nightly' },
      now,
    );
    expect(scored.status).toBe('pending_review');
    expect(scored.verdict).toBe('pass');
    expect(scored.submittedAt).toBe(submitted.submittedAt);
    expect(scored.updatedAt).not.toBe(submitted.updatedAt);

    await writeReplayRun(storage, DATA, submitted.id, 'r1', { mean: 0.42 }, now);
    expect(await listReplayRunIds(storage, DATA, submitted.id)).toEqual(['r1']);
    expect(await readReplayRun(storage, DATA, submitted.id, 'r1')).toEqual({ mean: 0.42 });

    const audit = await readAudit(storage, DATA, { candidateId: submitted.id });
    expect(audit.map((e) => e.action)).toEqual(['submitted', 'status', 'replay']);
    expect(audit[1]?.from).toBe('pending_replay');
    expect(audit[1]?.to).toBe('pending_review');
    expect(audit[1]?.verdict).toBe('pass');

    const listed = await listCandidates(storage, DATA, { personalityId: 'researcher' });
    expect(listed.map((c) => c.id)).toEqual([submitted.id]);
    expect(await listCandidates(storage, DATA, { status: 'promoted' })).toEqual([]);
  });

  it('records a null baseHash when nothing lives at the destination yet', async () => {
    const candidate = await submitCandidate(
      storage,
      DATA,
      {
        kind: 'skill',
        op: 'create',
        personalityId: 'researcher',
        origin: 'chat',
        destination: '/ethos/skills/brand-new.md',
        content: '# new',
      },
      now,
    );
    expect(candidate.baseHash).toBeNull();
  });

  it('refuses to update a candidate that is not there', async () => {
    await expect(
      updateCandidate(storage, DATA, 'c-nope', { status: 'rejected' }, now),
    ).rejects.toThrow(/No such learning candidate/);
  });
});

describe('readTargetFile', () => {
  it('reads the generated frontmatter key and nothing else', () => {
    const md = [
      '---',
      'name: rewrite-summarise-1',
      'ethos:',
      '  evolution:',
      '    auto_proposed: true',
      '    target_file: summarise.md',
      '---',
      '',
      'body target_file: not-this.md',
    ].join('\n');
    expect(readTargetFile(md)).toBe('summarise.md');
    expect(readTargetFile('no frontmatter here')).toBeNull();
  });
});

describe('legacy import', () => {
  const deps = () => ({
    storage,
    dataDir: DATA,
    skillDestinationDir: (pid: string) =>
      pid === 'researcher' ? `/ethos/personalities/${pid}/skills` : '/ethos/skills',
    soulFile: (pid: string) => `/ethos/personalities/${pid}/SOUL.md`,
    defaultPersonalityId: 'assistant',
    now,
  });

  async function seedAllFour(): Promise<void> {
    await seed('/ethos/skills/pending/evolver-1.md', '---\nname: evolver-1\n---\nfrom the evolver');
    await seed('/ethos/skills/.pending/chat-1.md', '---\nname: chat-1\n---\nfrom chat');
    await seed(
      '/ethos/skills/.pending/researcher/rewrite-summarise-9.md',
      '---\nname: rewrite-summarise-9\nethos:\n  evolution:\n    target_file: summarise.md\n---\nfrom the fork',
    );
    await seed(
      '/ethos/learning/pending-expression/researcher.json',
      JSON.stringify({
        personalityId: 'researcher',
        newExpression: 'I answer with sources.',
        rationale: 'alignment 0.62',
        evidenceRef: 'nightly:0.62@w1',
        baseHash: 'abc',
        at: '2026-09-11T00:00:00.000Z',
      }),
    );
  }

  it('drains all four sources into candidates', async () => {
    await seedAllFour();

    const result = await importLegacyQueues(deps());

    expect(result.alreadyImported).toBe(false);
    expect(result.sources).toEqual({
      skillsPending: 1,
      skillsDotPendingFlat: 1,
      skillsDotPendingPerPersonality: 1,
      pendingExpression: 1,
    });

    const all = await listCandidates(storage, DATA);
    expect(all).toHaveLength(4);

    const byRef = new Map(all.map((c) => [c.evidence.ref, c]));

    const evolver = byRef.get('/ethos/skills/pending/evolver-1.md');
    expect(evolver?.origin).toBe('legacy');
    expect(evolver?.op).toBe('create');
    expect(evolver?.personalityId).toBe('assistant');
    expect(evolver?.destination).toBe('/ethos/skills/evolver-1.md');

    const chat = byRef.get('/ethos/skills/.pending/chat-1.md');
    expect(chat?.personalityId).toBe('assistant');
    expect(chat?.destination).toBe('/ethos/skills/chat-1.md');

    const fork = byRef.get('/ethos/skills/.pending/researcher/rewrite-summarise-9.md');
    expect(fork?.op).toBe('rewrite');
    expect(fork?.personalityId).toBe('researcher');
    expect(fork?.destination).toBe('/ethos/personalities/researcher/skills/summarise.md');

    const expression = byRef.get('nightly:0.62@w1');
    expect(expression?.kind).toBe('expression');
    expect(expression?.op).toBe('update');
    expect(expression?.origin).toBe('nightly');
    expect(expression?.content).toBe('I answer with sources.');
    expect(expression?.destination).toBe('/ethos/personalities/researcher/SOUL.md');
    expect(expression?.evidence.digest).toBe('alignment 0.62');

    // …and empties them.
    expect(await storage.list('/ethos/skills/pending')).toEqual([]);
    expect(await storage.list('/ethos/skills/.pending')).toEqual(['researcher']);
    expect(await storage.list('/ethos/skills/.pending/researcher')).toEqual([]);
    expect(await storage.list('/ethos/learning/pending-expression')).toEqual([]);

    expect(await hasImportedLegacy(storage, DATA)).toBe(true);
  });

  it('changes nothing when it runs twice', async () => {
    await seedAllFour();
    await importLegacyQueues(deps());

    const first = await listCandidates(storage, DATA);
    const firstBytes = await Promise.all(first.map((c) => storage.read(candidatePath(DATA, c.id))));
    const auditBefore = await readAudit(storage, DATA);

    const second = await importLegacyQueues(deps());
    expect(second.alreadyImported).toBe(true);
    expect(second.candidateIds).toEqual([]);

    const after = await listCandidates(storage, DATA);
    expect(after.map((c) => c.id)).toEqual(first.map((c) => c.id));
    expect(await Promise.all(after.map((c) => storage.read(candidatePath(DATA, c.id))))).toEqual(
      firstBytes,
    );
    expect(await readAudit(storage, DATA)).toEqual(auditBefore);
  });

  it('is still a no-op with the marker gone — the drain is the idempotence', async () => {
    await seedAllFour();
    await importLegacyQueues(deps());
    const first = await listCandidates(storage, DATA);

    await storage.remove(legacyImportMarkerPath(DATA));
    const second = await importLegacyQueues(deps());

    expect(second.candidateIds).toEqual([]);
    expect((await listCandidates(storage, DATA)).map((c) => c.id)).toEqual(first.map((c) => c.id));
  });

  it('marks a hand-edited target_file invalid rather than promoting a create', async () => {
    await seed(
      '/ethos/skills/pending/rewrite-bad.md',
      '---\nname: rewrite-bad\nethos:\n  evolution:\n    target_file: ../../etc/passwd\n---\nbody',
    );

    await importLegacyQueues(deps());

    const [candidate] = await listCandidates(storage, DATA);
    expect(candidate?.status).toBe('invalid');
    expect(candidate?.op).toBe('create');
    expect(candidate?.destination).toBe('/ethos/skills/rewrite-bad.md');
    const audit = await readAudit(storage, DATA, { candidateId: candidate?.id ?? '' });
    expect(audit.at(-1)?.reason).toContain('unusable target_file');
  });
});
