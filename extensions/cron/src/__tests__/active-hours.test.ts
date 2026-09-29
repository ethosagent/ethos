// Active hours (plan personality-presence-and-initiative §6): a job with
// `activeHours` never runs its turn outside the window. The skip happens
// before the turn (zero LLM calls), is audited as 'inactive-hours-skip', and
// consumes the occurrence — it is not a missed run for `missedRunPolicy`.
// The skip is not a run: `runCount`, `lastRunAt` and the run history are
// untouched, and a once/count job is not retired by it. A manual run ignores
// the window. The window is read on the host's clock, the one croner reads
// the schedule on, so each test pins `process.env.TZ` (Node re-reads it on
// assignment). The clock is fixed with vitest's fake Date, as in
// run-integrity.test.ts.

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CronDecision,
  type CronJob,
  type CronRunResult,
  CronScheduler,
  type CronSchedulerConfig,
  isActiveAt,
  parseActiveHours,
} from '../index';

let testDir: string;
let prevTz: string | undefined;

beforeEach(async () => {
  prevTz = process.env.TZ;
  process.env.TZ = 'UTC';
  testDir = join(tmpdir(), `ethos-cron-active-hours-${Date.now()}-${Math.random()}`);
  await mkdir(join(testDir, 'scripts'), { recursive: true });
});

afterEach(async () => {
  vi.useRealTimers();
  if (prevTz === undefined) delete process.env.TZ;
  else process.env.TZ = prevTz;
  await rm(testDir, { recursive: true, force: true });
});

function harness(extra: Partial<CronSchedulerConfig> = {}) {
  const runs: string[] = [];
  const decisions: Array<CronDecision & { ranAt: string; delivered: boolean }> = [];
  const scheduler = new CronScheduler({
    cronDir: testDir,
    scriptsDir: join(testDir, 'scripts'),
    tickIntervalMs: 999_999,
    storage: new FsStorage(),
    runJob: async (job: CronJob): Promise<CronRunResult> => {
      runs.push(new Date().toISOString());
      return {
        jobId: job.id,
        ranAt: new Date().toISOString(),
        output: 'checked in',
        sessionKey: `cron:${job.id}`,
      };
    },
    onDecision: (_job, decision) => decisions.push(decision),
    ...extra,
  });
  return { scheduler, runs, decisions };
}

describe('activeHours — the window is evaluated before the turn', () => {
  it('fires at 10:00 and skips at 20:00 (zero LLM calls, audited) on the host clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Asia/Kolkata is UTC+05:30 with no DST: 04:00Z is 09:30 local.
    process.env.TZ = 'Asia/Kolkata';
    vi.setSystemTime(new Date('2026-10-01T04:00:00.000Z'));
    const { scheduler, runs, decisions } = harness();
    const job = await scheduler.createJob({
      name: 'Check in',
      schedule: 'every 1h',
      prompt: 'Anything worth saying?',
      personalityId: 'test',
      missedRunPolicy: 'run-once',
      activeHours: '09:00-17:00',
    });
    expect(job.activeHours).toBe('09:00-17:00');

    // 10:00 local — inside the window: the turn runs.
    vi.setSystemTime(new Date('2026-10-01T05:00:00.000Z'));
    await scheduler.fire();
    expect(runs).toHaveLength(1);

    // 20:00 local — outside: no turn, one audited skip.
    vi.setSystemTime(new Date('2026-10-01T14:30:00.000Z'));
    await scheduler.fire();
    expect(runs).toHaveLength(1);
    const skip = decisions.find((d) => d.action === 'inactive-hours-skip');
    expect(skip).toBeDefined();
    expect(skip?.delivered).toBe(false);
  });

  it('a skipped occurrence is consumed, so run-once never fires it later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T19:30:00.000Z'));
    const { scheduler, runs } = harness();
    const job = await scheduler.createJob({
      name: 'Evening check',
      schedule: 'every 1h',
      prompt: 'p',
      personalityId: 'test',
      missedRunPolicy: 'run-once',
      activeHours: '09:00-17:00',
    });
    vi.setSystemTime(new Date('2026-10-01T20:30:00.000Z'));
    await scheduler.fire(); // due 20:30, outside → skipped
    expect(runs).toHaveLength(0);
    const after = await scheduler.getJob(job.id);
    // The claim advanced nextRunAt past the skipped occurrence.
    expect(after?.nextRunAt).toBe('2026-10-01T21:30:00.000Z');
    // A later tick before the next occurrence runs nothing.
    vi.setSystemTime(new Date('2026-10-01T21:00:00.000Z'));
    await scheduler.fire();
    expect(runs).toHaveLength(0);
  });

  it('a window that crosses midnight is active late at night and early morning', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T22:30:00.000Z'));
    const { scheduler, runs, decisions } = harness();
    const job = await scheduler.createJob({
      name: 'Night owl',
      schedule: 'every 1h',
      prompt: 'p',
      personalityId: 'test',
      missedRunPolicy: 'run-once',
      activeHours: '22:00-06:00',
    });
    vi.setSystemTime(new Date('2026-10-01T23:30:00.000Z'));
    await scheduler.fire(); // 23:30 — inside
    expect(runs).toHaveLength(1);

    const patchJob = (p: Partial<CronJob>) =>
      // biome-ignore lint/suspicious/noExplicitAny: test access to private method
      (scheduler as any).patchJob(job.id, p) as Promise<void>;
    await patchJob({ nextRunAt: '2026-10-02T03:00:00.000Z' });
    vi.setSystemTime(new Date('2026-10-02T03:00:00.000Z'));
    await scheduler.fire(); // 03:00 — inside
    expect(runs).toHaveLength(2);

    await patchJob({ nextRunAt: '2026-10-02T12:00:00.000Z' });
    vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'));
    await scheduler.fire(); // 12:00 — outside
    expect(runs).toHaveLength(2);
    expect(decisions.map((d) => d.action)).toContain('inactive-hours-skip');
  });

  it('isActiveAt: end is exclusive, start inclusive, across midnight too', () => {
    const at = (iso: string) => new Date(iso).getTime();
    const day = parseActiveHours('09:00-17:00');
    const night = parseActiveHours('22:00-06:00');
    if (!day || !night) throw new Error('expected valid windows');
    expect(isActiveAt(day, 'UTC', at('2026-10-01T09:00:00Z'))).toBe(true);
    expect(isActiveAt(day, 'UTC', at('2026-10-01T17:00:00Z'))).toBe(false);
    expect(isActiveAt(night, 'UTC', at('2026-10-01T22:00:00Z'))).toBe(true);
    expect(isActiveAt(night, 'UTC', at('2026-10-01T05:59:00Z'))).toBe(true);
    expect(isActiveAt(night, 'UTC', at('2026-10-01T06:00:00Z'))).toBe(false);
  });
});

describe('activeHours — an invalid window is refused', () => {
  const base = {
    name: 'Bad window',
    schedule: 'every 1h',
    prompt: 'p',
    personalityId: 'test',
    missedRunPolicy: 'skip' as const,
  };

  it.each(['25:00-07:00', '9am-5pm', '09:00', '09:00-09:00', ''])(
    'refuses %j at create',
    async (activeHours) => {
      const { scheduler } = harness();
      await expect(scheduler.createJob({ ...base, activeHours })).rejects.toThrow(/activeHours/);
      expect(await scheduler.listJobs()).toHaveLength(0);
    },
  );

  it('refuses an invalid window at update, and null clears a valid one', async () => {
    const { scheduler } = harness();
    const job = await scheduler.createJob({ ...base, activeHours: '09:00-17:00' });
    await expect(scheduler.updateJob(job.id, { activeHours: '24:00-01:00' })).rejects.toThrow(
      /activeHours/,
    );
    expect((await scheduler.getJob(job.id))?.activeHours).toBe('09:00-17:00');

    const moved = await scheduler.updateJob(job.id, { activeHours: '08:30-18:00' });
    expect(moved.activeHours).toBe('08:30-18:00');
    const cleared = await scheduler.updateJob(job.id, { activeHours: null });
    expect(cleared.activeHours).toBeUndefined();
  });
});

describe('activeHours — a skip is not a run', () => {
  it('does not bump runCount, stamp lastRunAt or write run history', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T19:30:00.000Z'));
    const { scheduler, runs } = harness();
    const job = await scheduler.createJob({
      name: 'Evening check',
      schedule: 'every 1h',
      prompt: 'p',
      personalityId: 'test',
      missedRunPolicy: 'run-once',
      activeHours: '09:00-17:00',
    });
    vi.setSystemTime(new Date('2026-10-01T20:30:00.000Z'));
    await scheduler.fire();
    expect(runs).toHaveLength(0);
    const after = await scheduler.getJob(job.id);
    expect(after?.runCount).toBe(0);
    expect(after?.lastRunAt).toBeUndefined();
    expect(after?.status).toBe('active');
    // No history entry: `contextFrom` reads a job's latest run as context,
    // and a skip marker is not output (`resolveContext`).
    expect(await scheduler.listRuns(job.id)).toHaveLength(0);
  });

  it('a once job skipped outside its window stays active and runs at the next in-window occurrence', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T22:30:00.000Z'));
    const { scheduler, runs } = harness();
    const job = await scheduler.createJob({
      name: 'Morning once',
      schedule: '0 * * * *',
      prompt: 'p',
      personalityId: 'test',
      missedRunPolicy: 'run-once',
      repeat: { kind: 'once' },
      activeHours: '09:00-21:00',
    });
    expect(job.nextRunAt).toBe('2026-10-01T23:00:00.000Z');
    vi.setSystemTime(new Date('2026-10-01T23:00:00.000Z'));
    await scheduler.fire(); // 23:00 — outside: skipped, not retired
    expect(runs).toHaveLength(0);
    let after = await scheduler.getJob(job.id);
    expect(after?.status).toBe('active');
    expect(after?.runCount).toBe(0);
    expect(after?.nextRunAt).toBe('2026-10-02T00:00:00.000Z');

    // The next in-window occurrence runs it, and only then is it done.
    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).patchJob(job.id, { nextRunAt: '2026-10-02T09:00:00.000Z' });
    vi.setSystemTime(new Date('2026-10-02T09:00:00.000Z'));
    await scheduler.fire();
    expect(runs).toHaveLength(1);
    after = await scheduler.getJob(job.id);
    expect(after?.status).toBe('done');
    expect(after?.runCount).toBe(1);
  });

  it('a count-limited job spends its count only on runs inside the window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T15:30:00.000Z'));
    const { scheduler, runs } = harness();
    const job = await scheduler.createJob({
      name: 'Twice',
      schedule: 'every 1h',
      prompt: 'p',
      personalityId: 'test',
      missedRunPolicy: 'run-once',
      repeat: { kind: 'count', maxRuns: 2 },
      activeHours: '09:00-17:00',
    });
    vi.setSystemTime(new Date('2026-10-01T16:30:00.000Z'));
    await scheduler.fire(); // inside → run 1
    vi.setSystemTime(new Date('2026-10-01T17:30:00.000Z'));
    await scheduler.fire(); // outside → skip
    vi.setSystemTime(new Date('2026-10-01T18:30:00.000Z'));
    await scheduler.fire(); // outside → skip
    expect(runs).toHaveLength(1);
    const after = await scheduler.getJob(job.id);
    expect(after?.runCount).toBe(1);
    expect(after?.status).toBe('active');
  });
});

describe('activeHours — a manual run ignores the window', () => {
  it('runJobNow outside the window runs the turn', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T23:00:00.000Z'));
    const { scheduler, runs, decisions } = harness();
    const job = await scheduler.createJob({
      name: 'Check in',
      schedule: 'every 1h',
      prompt: 'p',
      personalityId: 'test',
      missedRunPolicy: 'skip',
      activeHours: '09:00-21:00',
    });
    const result = await scheduler.runJobNow(job.id);
    expect(runs).toHaveLength(1);
    expect(result.output).toBe('checked in');
    expect(decisions.map((d) => d.action)).not.toContain('inactive-hours-skip');
  });
});

describe('activeHours — refused on one-shot schedules', () => {
  const base = {
    name: 'Once',
    prompt: 'p',
    personalityId: 'test',
    missedRunPolicy: 'skip' as const,
  };

  it.each(['30m', '2026-12-01T09:00:00Z'])(
    'refuses activeHours with %j at create',
    async (schedule) => {
      const { scheduler } = harness();
      await expect(
        scheduler.createJob({ ...base, schedule, activeHours: '09:00-21:00' }),
      ).rejects.toThrow(/one-shot/);
      expect(await scheduler.listJobs()).toHaveLength(0);
    },
  );

  it('refuses adding a window to a one-shot, and a one-shot schedule on a windowed job', async () => {
    const { scheduler } = harness();
    const once = await scheduler.createJob({ ...base, schedule: '30m' });
    await expect(scheduler.updateJob(once.id, { activeHours: '09:00-21:00' })).rejects.toThrow(
      /one-shot/,
    );
    expect((await scheduler.getJob(once.id))?.activeHours).toBeUndefined();

    const windowed = await scheduler.createJob({
      ...base,
      name: 'Windowed',
      schedule: 'every 1h',
      activeHours: '09:00-21:00',
    });
    await expect(scheduler.updateJob(windowed.id, { schedule: '30m' })).rejects.toThrow(/one-shot/);
    expect((await scheduler.getJob(windowed.id))?.schedule).toBe('every 1h');
    // Clearing the window in the same patch makes the one-shot legal.
    const moved = await scheduler.updateJob(windowed.id, { schedule: '30m', activeHours: null });
    expect(moved.schedule).toBe('30m');
    expect(moved.activeHours).toBeUndefined();
  });
});

describe('activeHours — the window is read on the schedule clock', () => {
  it('a cron expression and its window agree in the host zone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 20:00 in Kolkata is 14:30Z; UTC would read that as outside 19:00-21:00.
    process.env.TZ = 'Asia/Kolkata';
    vi.setSystemTime(new Date('2026-10-01T10:00:00.000Z'));
    const { scheduler, runs } = harness();
    const job = await scheduler.createJob({
      name: 'Eight pm',
      schedule: '0 20 * * *',
      prompt: 'p',
      personalityId: 'test',
      missedRunPolicy: 'run-once',
      activeHours: '19:00-21:00',
    });
    expect(job.nextRunAt).toBe('2026-10-01T14:30:00.000Z');
    vi.setSystemTime(new Date('2026-10-01T14:30:00.000Z'));
    await scheduler.fire();
    expect(runs).toHaveLength(1);
  });
});
