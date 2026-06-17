import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { buildWeeklyDigest, isoWeek, isoWeekLabel } from '../commands/digest';

const DATA_DIR = '/tmp/ethos-digest-test';

function personality(id: string): PersonalityConfig {
  return { id, name: id };
}

async function seedJudge(
  storage: InMemoryStorage,
  id: string,
  alignmentScore: number,
  signal: 'drift' | 'underspecified_soul' | null,
) {
  const path = join(DATA_DIR, 'personalities', id, '.judge-history', 'state.json');
  await storage.mkdir(join(DATA_DIR, 'personalities', id, '.judge-history'));
  await storage.write(
    path,
    JSON.stringify({
      lowStreak: 2,
      lastResult: { alignmentScore, signal, sampleCount: 10 },
      at: '2026-06-16T00:00:00Z',
    }),
  );
}

async function seedNightly(
  storage: InMemoryStorage,
  id: string,
  windowEnd: string,
  completed: string[],
) {
  await storage.mkdir(join(DATA_DIR, 'personalities', id));
  await storage.write(
    join(DATA_DIR, 'personalities', id, '.nightly-state.json'),
    JSON.stringify({ windowEnd, completed }),
  );
}

async function seedSkillCandidate(storage: InMemoryStorage, id: string, fileName: string) {
  await storage.mkdir(join(DATA_DIR, 'skills', '.pending', id));
  await storage.write(join(DATA_DIR, 'skills', '.pending', id, fileName), '# candidate');
}

describe('isoWeek helpers', () => {
  it('computes ISO week label', () => {
    // 2026-06-17 is a Wednesday in ISO week 25.
    const { year, week } = isoWeek(new Date('2026-06-17T12:00:00Z'));
    expect(year).toBe(2026);
    expect(week).toBe(25);
    expect(isoWeekLabel(new Date('2026-06-17T12:00:00Z'))).toBe('2026-W25');
  });
});

describe('buildWeeklyDigest', () => {
  const now = new Date('2026-06-17T12:00:00Z');

  it('renders activity sections for a personality with recent learning, judge, and candidates', async () => {
    const storage = new InMemoryStorage();
    await seedJudge(storage, 'coder', 0.82, 'drift');
    await seedNightly(storage, 'coder', '2026-06-16T03:00:00Z', ['judge', 'evolve']);
    await seedSkillCandidate(storage, 'coder', 'use-rg.md');

    const md = await buildWeeklyDigest({
      personalities: [personality('coder')],
      storage,
      dataDir: DATA_DIR,
      now,
      learningLogByPersonality: {
        coder: [
          {
            revisionId: 'expr-rev-3',
            at: '2026-06-15T00:00:00Z',
            summary: 'tightened code-review tone',
            evidenceRef: 'judge:0.82@2026-06-15',
            prevExpressionRef: 'expr-rev-2',
          },
        ],
      },
    });

    expect(md).toContain('## coder');
    expect(md).toContain('Expressions evolved (1)');
    expect(md).toContain('expr-rev-3: tightened code-review tone');
    expect(md).toContain('Alignment 82%');
    expect(md).toContain('signal: drift');
    expect(md).toContain('2026-06-16T03:00:00Z');
    expect(md).toContain('judge, evolve');
    expect(md).toContain('New skill candidates (1)');
    expect(md).toContain('use-rg.md');
    expect(md).toContain('Expressions evolved: 1');
    expect(md).toContain('New skill candidates: 1');
  });

  it('renders "No activity" for a personality with nothing', async () => {
    const storage = new InMemoryStorage();
    const md = await buildWeeklyDigest({
      personalities: [personality('idle')],
      storage,
      dataDir: DATA_DIR,
      now,
    });
    expect(md).toContain('## idle');
    expect(md).toContain('No activity this week.');
    expect(md).toContain('(0 with activity)');
  });

  it('excludes learning-log entries outside the window', async () => {
    const storage = new InMemoryStorage();
    const md = await buildWeeklyDigest({
      personalities: [personality('coder')],
      storage,
      dataDir: DATA_DIR,
      now,
      windowDays: 7,
      learningLogByPersonality: {
        coder: [
          {
            revisionId: 'expr-rev-old',
            at: '2026-05-01T00:00:00Z',
            summary: 'old change',
            evidenceRef: 'x',
            prevExpressionRef: 'y',
          },
        ],
      },
    });
    // No judge/nightly/candidate either → no activity.
    expect(md).toContain('No activity this week.');
    expect(md).not.toContain('expr-rev-old');
    expect(md).toContain('Expressions evolved: 0');
  });

  it('writing the same week twice overwrites a single file', async () => {
    const storage = new InMemoryStorage();
    const digestDir = join(DATA_DIR, 'digests');
    await storage.mkdir(digestDir);
    const label = isoWeekLabel(now);
    const outPath = join(digestDir, `${label}.md`);

    const first = await buildWeeklyDigest({
      personalities: [personality('coder')],
      storage,
      dataDir: DATA_DIR,
      now,
    });
    await storage.writeAtomic(outPath, first);
    const second = await buildWeeklyDigest({
      personalities: [personality('coder')],
      storage,
      dataDir: DATA_DIR,
      now,
    });
    await storage.writeAtomic(outPath, second);

    const entries = await storage.list(digestDir);
    expect(entries.filter((e) => e === `${label}.md`)).toHaveLength(1);
    expect(await storage.read(outPath)).toBe(second);
  });

  it('tolerates a malformed judge sidecar (treated as empty)', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(join(DATA_DIR, 'personalities', 'coder', '.judge-history'));
    await storage.write(
      join(DATA_DIR, 'personalities', 'coder', '.judge-history', 'state.json'),
      'not json {',
    );
    const md = await buildWeeklyDigest({
      personalities: [personality('coder')],
      storage,
      dataDir: DATA_DIR,
      now,
    });
    expect(md).toContain('No activity this week.');
  });
});
