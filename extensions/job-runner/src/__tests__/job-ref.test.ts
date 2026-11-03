import type { BackgroundJob, JobSteer } from '@ethosagent/types';
import { JOB_STEER_MAX_CHARS, JOB_STEER_MAX_PENDING } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  isActiveJob,
  isJobRef,
  resolveJobRef,
  steerRefusalText,
  stopRefusalText,
  unreadSteerPreview,
} from '../job-ref';

const mk = (id: string, status: BackgroundJob['status'] = 'running', runner?: string) =>
  ({ id, status, ...(runner ? { runner } : {}) }) as BackgroundJob;

describe('isJobRef / isActiveJob', () => {
  it('accepts a uuid or >=8 hex prefix, rejects words and short hex', () => {
    expect(isJobRef('3f2a1b9c')).toBe(true);
    expect(isJobRef('3f2a1b9c-aaaa-bbbb')).toBe(true);
    expect(isJobRef('3f2a1b9')).toBe(false);
    expect(isJobRef('the')).toBe(false);
  });

  it('treats queued/running/blocked as active', () => {
    expect(isActiveJob({ status: 'queued' })).toBe(true);
    expect(isActiveJob({ status: 'running' })).toBe(true);
    expect(isActiveJob({ status: 'blocked' })).toBe(true);
    expect(isActiveJob({ status: 'done' })).toBe(false);
  });
});

describe('resolveJobRef', () => {
  const jobs = [mk('aaaaaaaa-1'), mk('aaaaaaaa-2'), mk('bbbbbbbb-1')];

  it('prefers an exact id, then a unique prefix (case-insensitive)', () => {
    expect(resolveJobRef(jobs, 'aaaaaaaa-1')).toEqual({ kind: 'job', job: jobs[0] });
    expect(resolveJobRef(jobs, 'BBBBBBBB')).toEqual({ kind: 'job', job: jobs[2] });
  });

  it('reports ambiguity with full ids and none when nothing matches', () => {
    expect(resolveJobRef(jobs, 'aaaaaaaa')).toEqual({
      kind: 'ambiguous',
      ids: ['aaaaaaaa-1', 'aaaaaaaa-2'],
    });
    expect(resolveJobRef(jobs, 'cccccccc')).toEqual({ kind: 'none' });
  });
});

describe('refusal text', () => {
  const job = mk('3f2a1b9c-0000');

  it('words steer refusals from the shared limits', () => {
    expect(steerRefusalText(job, { ok: false, reason: 'full' })).toBe(
      `job 3f2a1b9c already has ${JOB_STEER_MAX_PENDING} unread steers — wait for it to catch up`,
    );
    expect(steerRefusalText(job, { ok: false, reason: 'too_long' })).toContain(
      `max ${JOB_STEER_MAX_CHARS} characters`,
    );
    expect(steerRefusalText(job, { ok: false, reason: 'finished', status: 'done' })).toBe(
      'job 3f2a1b9c already finished (done)',
    );
    expect(
      steerRefusalText(mk('3f2a1b9c', 'running', 'codex'), { ok: false, reason: 'unsupported' }),
    ).toContain('runs on codex');
  });

  it('words stop refusals', () => {
    expect(stopRefusalText(job, { ok: false, reason: 'remote' })).toContain('another machine');
    expect(stopRefusalText(job, { ok: false, reason: 'finished' })).toBe(
      'job 3f2a1b9c already finished',
    );
  });
});

describe('unreadSteerPreview', () => {
  const steer = (text: string) => ({ text }) as JobSteer;

  it('shows the first lines flattened and truncated, and counts the rest', () => {
    const { shown, more } = unreadSteerPreview(
      [steer('a\nb'), steer('x'.repeat(200)), steer('c'), steer('d'), steer('e')],
      { lines: 3, chars: 120 },
    );
    expect(shown).toHaveLength(3);
    expect(shown[0]).toBe('a b');
    expect(shown[1]).toHaveLength(120);
    expect(shown[1]?.endsWith('…')).toBe(true);
    expect(more).toBe(2);
  });
});
