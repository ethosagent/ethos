// The jobs.json lock reclaims a lock its holder can no longer release.
//
// The failure these pin: `~/.ethos/cron/jobs.json.lock` — a zero-byte file
// left by a process killed inside the critical section — sat there for two
// weeks, and every `cron` create in every process waited 5s and failed with
// `Could not acquire lock`.

import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CronScheduler } from '../index';
import { withJobsFileLock } from '../jobs-lock';

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ethos-jobs-lock-'));
  lockPath = join(dir, 'jobs.json.lock');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Backdate the lock file's mtime by `ageMs`. */
function age(path: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  utimesSync(path, t, t);
}

const FAST = { timeoutMs: 300, pollMs: 20 };

describe('withJobsFileLock', () => {
  it('reclaims a legacy empty lock left behind by a killed process', async () => {
    writeFileSync(lockPath, '');
    age(lockPath, 60_000);
    const ran = await withJobsFileLock(lockPath, async () => 'ran', FAST);
    expect(ran).toBe('ran');
  });

  it('reclaims a lock whose recorded pid is not running', async () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 424242, boot: null, token: 'x' }));
    const ran = await withJobsFileLock(lockPath, async () => 'ran', {
      ...FAST,
      isAlive: (pid) => pid !== 424242,
    });
    expect(ran).toBe('ran');
  });

  it('does NOT reclaim a fresh empty lock (a holder between create and write)', async () => {
    writeFileSync(lockPath, '');
    await expect(withJobsFileLock(lockPath, async () => 'ran', FAST)).rejects.toThrow(
      /Could not acquire lock: .*no recorded holder/,
    );
  });

  it('never preempts a live holder, however old, and names it', async () => {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, boot: null, token: 'other' }));
    age(lockPath, 24 * 60 * 60_000);
    await expect(withJobsFileLock(lockPath, async () => 'ran', FAST)).rejects.toThrow(
      `held by running pid ${process.pid}`,
    );
    // Still the holder's lock — the waiter removed nothing.
    expect(readFileSync(lockPath, 'utf-8')).toContain('"token":"other"');
  });

  it('releases its own lock and records its pid while held', async () => {
    await withJobsFileLock(lockPath, async () => {
      expect(JSON.parse(readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
    });
    expect(() => readFileSync(lockPath)).toThrow();
  });

  it('does not delete a lock another holder took over while it ran', async () => {
    await withJobsFileLock(lockPath, async () => {
      writeFileSync(lockPath, JSON.stringify({ pid: 1, token: 'peer' }));
    });
    expect(readFileSync(lockPath, 'utf-8')).toContain('peer');
  });

  it('serializes concurrent holders in one process', async () => {
    const order: string[] = [];
    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        withJobsFileLock(
          lockPath,
          async () => {
            order.push(`${id}+`);
            await new Promise((r) => setTimeout(r, 10));
            order.push(`${id}-`);
          },
          { pollMs: 5 },
        ),
      ),
    );
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]?.slice(0, 1)).toBe(order[i + 1]?.slice(0, 1));
    }
  });
});

describe('CronScheduler with a stale jobs.json.lock', () => {
  it('creates a job instead of failing with Could not acquire lock', async () => {
    writeFileSync(join(dir, 'jobs.json.lock'), '');
    age(join(dir, 'jobs.json.lock'), 14 * 24 * 60 * 60_000);
    const scheduler = new CronScheduler({
      cronDir: dir,
      scriptsDir: join(dir, 'scripts'),
      tickIntervalMs: 999_999,
      storage: new FsStorage(),
      runJob: async (job) => ({
        jobId: job.id,
        ranAt: new Date().toISOString(),
        output: 'ok',
        sessionKey: `cron:${job.id}`,
      }),
    });
    await scheduler.createJob({
      name: 'nightly',
      schedule: '0 9 * * *',
      prompt: 'hi',
      personalityId: 'p',
      missedRunPolicy: 'skip',
    });
    const jobs = JSON.parse(readFileSync(join(dir, 'jobs.json'), 'utf-8')) as Array<{
      name: string;
    }>;
    expect(jobs.map((j) => j.name)).toEqual(['nightly']);
  });
});
