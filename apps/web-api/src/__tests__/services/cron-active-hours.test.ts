// A cron job's `activeHours` over the web API (plan personality-presence-and-initiative §6):
// `cron.create` / `cron.update` carry it through to `CronScheduler`, `null`
// clears it, and every wire job reports it (`toWireJob`). Real scheduler on a
// scratch dir, driven through the oRPC router.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CronScheduler } from '@ethosagent/cron';
import { FsStorage } from '@ethosagent/storage-fs';
import { call } from '@orpc/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cronRouter } from '../../rpc/cron';
import { CronService } from '../../services/cron.service';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ethos-web-cron-active-hours-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function context() {
  const scheduler = new CronScheduler({
    cronDir: dir,
    scriptsDir: join(dir, 'scripts'),
    storage: new FsStorage(),
    runJob: async (job) => ({
      jobId: job.id,
      ranAt: new Date().toISOString(),
      output: '',
      sessionKey: `cron:${job.id}`,
    }),
  });
  return { cron: new CronService({ scheduler }) } as never;
}

const BASE = {
  name: 'Check in',
  schedule: '0 */3 * * *',
  prompt: 'Anything?',
  personalityId: 'researcher',
};

describe('cron activeHours over the web API', () => {
  it('create stores it, get reports it, update moves it and null clears it', async () => {
    const ctx = context();
    const created = await call(
      cronRouter.create,
      { ...BASE, activeHours: '09:00-21:00' },
      { context: ctx },
    );
    expect(created.job.activeHours).toBe('09:00-21:00');

    const moved = await call(
      cronRouter.update,
      { id: created.job.id, activeHours: '08:00-18:00' },
      { context: ctx },
    );
    expect(moved.job.activeHours).toBe('08:00-18:00');

    const cleared = await call(
      cronRouter.update,
      { id: created.job.id, activeHours: null },
      { context: ctx },
    );
    expect(cleared.job.activeHours).toBeNull();
    const listed = await call(cronRouter.list, undefined, { context: ctx });
    expect(listed.jobs[0]?.activeHours).toBeNull();
  });

  it('refuses a malformed window with CRON_INVALID', async () => {
    const ctx = context();
    await expect(
      call(cronRouter.create, { ...BASE, activeHours: '9am-5pm' }, { context: ctx }),
    ).rejects.toThrow(/activeHours/);
  });
});
