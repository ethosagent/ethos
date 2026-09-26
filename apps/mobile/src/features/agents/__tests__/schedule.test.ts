import { describe, expect, it } from 'vitest';
import { firingRow, jobsFor, recentFirings } from '../schedule';

const job = (id: string, personalityId: string) => ({ id, name: `job-${id}`, personalityId });

describe('jobsFor', () => {
  it('keeps only the personality’s own jobs', () => {
    const jobs = [job('a', 'engineer'), job('b', 'cmo'), job('c', 'engineer')];
    expect(jobsFor(jobs, 'engineer').map((j) => j.id)).toEqual(['a', 'c']);
    expect(jobsFor(jobs, 'nobody')).toEqual([]);
  });
});

describe('firingRow', () => {
  const j = job('a', 'engineer');
  it('a script failure carries its reason', () => {
    const row = firingRow(j, {
      ranAt: '2026-09-27T09:41:00Z',
      outputPath: '/x/1.md',
      output: '# job-a\n\n[script failed] exited 2: no such file\n',
    });
    expect(row.glyph).toBe('✗');
    expect(row.word).toBe('failed');
    expect(row.result).toBe('exited 2: no such file');
  });

  it('a success shows the first line of its output', () => {
    const row = firingRow(j, {
      ranAt: '2026-09-27T09:41:00Z',
      outputPath: '/x/1.md',
      output: '# job-a\n\nAll quiet.\nsecond line\n',
    });
    expect(row).toMatchObject({ glyph: '✓', word: 'ran', result: 'All quiet.' });
  });

  it('a listed run without a body is a plain `ran`', () => {
    const row = firingRow(j, {
      ranAt: '2026-09-27T09:41:00Z',
      outputPath: '/x/1.md',
      output: null,
    });
    expect(row).toMatchObject({ glyph: '·', word: 'ran', subject: 'job-a' });
    expect(row.result).toBeUndefined();
  });
});

describe('recentFirings', () => {
  it('merges jobs newest first and caps', () => {
    const rows = recentFirings(
      [
        {
          job: job('a', 'e'),
          runs: [{ ranAt: '2026-09-27T08:00:00Z', outputPath: 'a1', output: null }],
        },
        {
          job: job('b', 'e'),
          runs: [
            { ranAt: '2026-09-27T09:00:00Z', outputPath: 'b1', output: null },
            { ranAt: '2026-09-27T07:00:00Z', outputPath: 'b2', output: null },
          ],
        },
      ],
      2,
    );
    expect(rows.map((r) => r.key)).toEqual(['b1', 'a1']);
  });
});
