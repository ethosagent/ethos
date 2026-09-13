// L-T8 — `ethos learning`. The command is a printer over `LearningInbox`; what
// is pinned here is what a human reads before deciding: the scorecard as a
// table, WITH the dry-run caveat the scorecard carries (L-D4), and the approve
// path's override hint.

import { join } from 'node:path';
import {
  REPLAY_LIMITATIONS,
  type ReplayReport,
  submitCandidate,
  updateCandidate,
  writeReplayRun,
} from '@ethosagent/learning-inbox';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { createLearningInbox, type LearningInbox } from '@ethosagent/wiring';
import { beforeEach, describe, expect, it } from 'vitest';
import { runLearningCommand } from '../learning';

const DATA = '/ethos';
const LIVE = join(DATA, 'skills');
const SKILL = '---\nname: cite-sources\ndescription: "Always cite"\n---\n\nCite every claim.\n';

let storage: InMemoryStorage;
let inbox: LearningInbox;
let out: string[];
let err: string[];
const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };

// Strip ANSI colour so assertions read the text a human reads.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (lines: string[]) => lines.join('\n').replace(ANSI, '');

beforeEach(async () => {
  storage = new InMemoryStorage();
  out = [];
  err = [];
  const dir = join(DATA, 'personalities', 'scout');
  await storage.mkdir(dir);
  await storage.write(join(dir, 'config.yaml'), 'name: Scout\n');
  const registry = new FilePersonalityRegistry(storage, DATA);
  await registry.loadFromDirectory(join(DATA, 'personalities'));
  inbox = createLearningInbox({
    storage,
    dataDir: DATA,
    personalities: registry,
    expressions: registry,
    defaultPersonalityId: 'scout',
  });
});

async function submit() {
  return submitCandidate(storage, DATA, {
    kind: 'skill',
    op: 'create',
    personalityId: 'scout',
    origin: 'nightly',
    destination: join(LIVE, 'cite-sources.md'),
    content: SKILL,
    evidence: { digest: 'three sessions where sources were missing' },
  });
}

function arm(which: 'baseline' | 'candidate', score: number) {
  return {
    arm: which,
    text: `${which} answer`,
    plan: [],
    errors: [],
    halts: [],
    costUsd: 0.02,
    completed: true,
    assertions: [{ kind: 'criteria' as const, value: 'cites a source', passed: score === 1 }],
    score,
  };
}

describe('ethos learning show', () => {
  it('prints the replay scorecard as a table, with the dry-run caveat', async () => {
    const candidate = await submit();
    const report: ReplayReport = {
      runId: 'r-test-1',
      candidateId: candidate.id,
      testedOn: 'scout',
      startedAt: '2026-09-13T00:00:00.000Z',
      finishedAt: '2026-09-13T00:02:00.000Z',
      verdict: 'pass',
      rules: { a: true, b: true, c: true, d: true },
      targetMeanDelta: 0.5,
      regressionMeanDelta: 0,
      regressionsWorse: 0,
      regressionCount: 2,
      costUsd: 0.12,
      maxCostUsd: 0.5,
      stopReason: null,
      error: null,
      cases: [
        {
          caseId: 'case-target-1',
          role: 'target',
          source: 'session',
          sourceRef: 'cli:proj#m1',
          prompt: 'summarise the paper',
          baseline: arm('baseline', 0.5),
          candidate: arm('candidate', 1),
          delta: 0.5,
        },
        {
          caseId: 'case-regress-1',
          role: 'regression',
          source: 'kanban',
          sourceRef: 'task-9',
          prompt: 'draft the brief',
          baseline: arm('baseline', 1),
          candidate: arm('candidate', 1),
          delta: 0,
        },
      ],
      skipped: [],
      limitations: REPLAY_LIMITATIONS,
    };
    await writeReplayRun(storage, DATA, candidate.id, 'r-test-1', report);

    const code = await runLearningCommand(['show', candidate.id], inbox, io);
    const text = plain(out);

    expect(code).toBe(0);
    expect(text).toContain('Replay scorecard');
    expect(text).toContain('Pass · target +0.50 · regressions 0/2 · $0.12 of $0.50');
    expect(text).toMatch(/CASE\s+ROLE\s+SOURCE\s+BASELINE\s+CANDIDATE\s+Δ/);
    expect(text).toMatch(/case-target-1\s+target\s+session\s+0\.50\s+1\.00\s+\+0\.50/);
    expect(text).toMatch(/case-regress-1\s+regression\s+kanban\s+1\.00\s+1\.00\s+\+0\.00/);
    // L-D4 — the caveat the scorecard carries, verbatim.
    expect(text).toContain(
      'dry-run: tools stubbed — replay measures tool choice, arguments, voice and approach, not answers that depend on real tool output',
    );
    expect(text).toContain('three sessions where sources were missing');
  });

  it('says the replay has not run when there is no scorecard', async () => {
    const candidate = await submit();
    await runLearningCommand(['show', candidate.id], inbox, io);
    expect(plain(out)).toContain(`not run — ethos learning replay ${candidate.id}`);
  });
});

describe('ethos learning approve', () => {
  it('refuses a never-replayed candidate and names --override', async () => {
    const candidate = await submit();
    const code = await runLearningCommand(['approve', candidate.id], inbox, io);

    expect(code).toBe(1);
    expect(plain(err)).toContain(`ethos learning approve ${candidate.id} --override "<reason>"`);
    expect(await storage.exists(join(LIVE, 'cite-sources.md'))).toBe(false);
  });

  it('--override "<reason>" promotes it', async () => {
    const candidate = await submit();
    const code = await runLearningCommand(
      ['approve', candidate.id, '--override', 'checked it by hand'],
      inbox,
      io,
    );

    expect(code).toBe(0);
    expect(await storage.read(join(LIVE, 'cite-sources.md'))).toBe(SKILL);
    expect(plain(out)).toContain('override recorded: checked it by hand');
  });

  it('a passing candidate needs no override; list then shows nothing waiting', async () => {
    const candidate = await submit();
    await updateCandidate(storage, DATA, candidate.id, {
      status: 'pending_review',
      verdict: 'pass',
    });

    expect(await runLearningCommand(['approve', candidate.id], inbox, io)).toBe(0);
    out = [];
    await runLearningCommand(['list'], inbox, io);
    expect(plain(out)).toContain('No learning candidates waiting for a decision.');
  });
});
