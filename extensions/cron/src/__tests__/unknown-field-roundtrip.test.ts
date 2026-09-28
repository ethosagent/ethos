// plan personality-memory-boundary step 5 — `CronJob.roomAudience` lives in
// `jobs.json`, which several processes (and several binary versions sharing one
// `~/.ethos`) rewrite whole. An older binary that has never heard of the field
// keeps it only because every rewrite spreads the record it read
// (`{ ...existing, ...patch }` in `patchJob`/`updateJob`, the untouched
// objects in `withJobsLock`). These cases pin that: a field this code does not
// declare — standing in for the next one — survives every mutation, and so
// does `roomAudience` itself.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CronScheduler } from '../index';

// A real directory: the jobs.json lock (`withJobsFileLock`) is a raw-fs
// sentinel, so an in-memory Storage cannot back it.
let CRON_DIR = '';
let JOBS_PATH = '';

beforeEach(async () => {
  CRON_DIR = await mkdtemp(join(tmpdir(), 'ethos-cron-roundtrip-'));
  JOBS_PATH = join(CRON_DIR, 'jobs.json');
});

afterEach(async () => {
  await rm(CRON_DIR, { recursive: true, force: true });
});

function seeded(): { storage: FsStorage; scheduler: CronScheduler } {
  const storage = new FsStorage();
  const scheduler = new CronScheduler({
    storage,
    cronDir: CRON_DIR,
    scriptsDir: join(CRON_DIR, 'scripts'),
    runJob: async (job) => ({
      jobId: job.id,
      ranAt: new Date().toISOString(),
      output: 'ok',
      sessionKey: `cron:${job.id}`,
    }),
  });
  return { storage, scheduler };
}

async function writeJobs(storage: FsStorage, jobs: unknown[]): Promise<void> {
  await storage.mkdir(CRON_DIR);
  await storage.write(JOBS_PATH, JSON.stringify(jobs, null, 2));
}

async function readJobs(storage: FsStorage): Promise<Array<Record<string, unknown>>> {
  const raw = await storage.read(JOBS_PATH);
  if (!raw) throw new Error('jobs.json missing');
  return JSON.parse(raw) as Array<Record<string, unknown>>;
}

const JOB = {
  id: 'daily',
  name: 'daily',
  schedule: '0 8 * * *',
  prompt: 'Summarize the news',
  personalityId: 'researcher',
  origin: { platform: 'telegram', chatId: '-100200' },
  roomAudience: 'shared',
  futureField: { kept: true },
  status: 'active',
  missedRunPolicy: 'skip',
  repeat: { kind: 'forever' },
  runCount: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
};

const OTHER = { ...JOB, id: 'other', name: 'other', futureField: 'second' };

describe('jobs.json keeps fields this code does not model', () => {
  it('pause and resume rewrite the file without dropping roomAudience or unknown fields', async () => {
    const { storage, scheduler } = seeded();
    await writeJobs(storage, [JOB, OTHER]);
    await scheduler.pauseJob('daily');
    await scheduler.resumeJob('daily');
    const [daily, other] = await readJobs(storage);
    expect(daily?.roomAudience).toBe('shared');
    expect(daily?.futureField).toEqual({ kept: true });
    // The job the mutation did not touch is carried verbatim too.
    expect(other?.futureField).toBe('second');
  });

  it('updateJob keeps them', async () => {
    const { storage, scheduler } = seeded();
    await writeJobs(storage, [JOB]);
    await scheduler.updateJob('daily', { prompt: 'Summarize the weather' });
    const [daily] = await readJobs(storage);
    expect(daily?.prompt).toBe('Summarize the weather');
    expect(daily?.roomAudience).toBe('shared');
    expect(daily?.futureField).toEqual({ kept: true });
  });

  it('creating another job keeps them on the existing one', async () => {
    const { storage, scheduler } = seeded();
    await writeJobs(storage, [JOB]);
    await scheduler.createJob({
      name: 'fresh',
      schedule: '0 9 * * *',
      prompt: 'hello',
      personalityId: 'researcher',
      missedRunPolicy: 'skip',
      roomAudience: 'private',
    });
    const jobs = await readJobs(storage);
    expect(jobs.find((j) => j.id === 'daily')?.futureField).toEqual({ kept: true });
    expect(jobs.find((j) => j.id === 'fresh')?.roomAudience).toBe('private');
  });

  it('a run keeps them (the runningSince stamp and clear spread the record)', async () => {
    const { storage, scheduler } = seeded();
    await writeJobs(storage, [JOB]);
    await scheduler.runJobNow('daily');
    const [daily] = await readJobs(storage);
    expect(daily?.runningSince).toBeNull();
    expect(daily?.roomAudience).toBe('shared');
    expect(daily?.futureField).toEqual({ kept: true });
  });
});
