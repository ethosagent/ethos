// Run-integrity rules for `CronScheduler` (plan/phases/upstream-bug-parity.md):
//  - UBP-004: a failed turn is a failed run — lastError, no runCount bump, a
//    one-shot is not retired, and an empty output is never delivered.
//  - UBP-026: a job is never executing twice at once.
//  - UBP-027: the missed-run grace is not the tick interval exactly, a
//    maxParallelJobs deferral is not a miss, and every skip leaves a record.
//  - UBP-029: a failed prompt job with an origin sends one rate-limited notice.

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CronJob,
  type CronRunResult,
  CronScheduler,
  type CronSchedulerConfig,
} from '../index';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-cron-integrity-${Date.now()}-${Math.random()}`);
  await mkdir(join(testDir, 'scripts'), { recursive: true });
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(testDir, { recursive: true, force: true });
});

const ok = (job: CronJob, output = 'x'): CronRunResult => ({
  jobId: job.id,
  ranAt: new Date().toISOString(),
  output,
  sessionKey: `cron:${job.id}`,
});

function makeScheduler(
  runJob: CronSchedulerConfig['runJob'],
  extra: Partial<CronSchedulerConfig> = {},
): CronScheduler {
  return new CronScheduler({
    cronDir: testDir,
    scriptsDir: join(testDir, 'scripts'),
    tickIntervalMs: 999_999,
    storage: new FsStorage(),
    runJob,
    ...extra,
  });
}

async function patch(scheduler: CronScheduler, id: string, p: Partial<CronJob>): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: test access to private method
  await (scheduler as any).patchJob(id, p);
}

/** A runJob that blocks its FIRST call until `release()`. */
function blockingRunJob() {
  const started: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let markRunning: () => void = () => {};
  const running = new Promise<void>((r) => {
    markRunning = r;
  });
  const runJob = async (job: CronJob): Promise<CronRunResult> => {
    started.push(job.id);
    if (started.length === 1) {
      markRunning();
      await gate;
    }
    return ok(job);
  };
  return { runJob, started, release: () => release(), running };
}

describe('UBP-004 — a failed turn is a failed run', () => {
  it('sets lastError, does not count the run, and does not retire a one-shot', async () => {
    const deliver = vi.fn(async (_job: CronJob, _text: string) => {});
    const scheduler = makeScheduler(
      async () => {
        throw new Error('[llm_error] provider returned 500');
      },
      { deliver },
    );
    const dueAt = new Date(Date.now() - 30_000).toISOString();
    const job = await scheduler.createJob({
      name: 'Call the bank',
      schedule: dueAt,
      prompt: 'remind me to call the bank',
      personalityId: 'test',
      missedRunPolicy: 'run-once',
      origin: { platform: 'telegram', chatId: '7' },
    });
    await patch(scheduler, job.id, { nextRunAt: dueAt });

    await scheduler.fire();
    let after = await scheduler.getJob(job.id);
    expect(after?.lastError).toContain('llm_error');
    expect(after?.runCount).toBe(0);
    expect(after?.status).not.toBe('done');

    // A later tick must not quietly retire it either.
    await scheduler.fire();
    after = await scheduler.getJob(job.id);
    expect(after?.status).not.toBe('done');
    // The only delivery is the failure notice (UBP-029) — never the empty output.
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[1]).toMatch(/failed/);
  });

  it('resuming a paused failed one-shot runs it again', async () => {
    let fail = true;
    const runs: string[] = [];
    const scheduler = makeScheduler(async (job) => {
      runs.push(job.id);
      if (fail) throw new Error('boom');
      return ok(job);
    });
    const dueAt = new Date(Date.now() - 30_000).toISOString();
    const job = await scheduler.createJob({
      name: 'Retry me',
      schedule: dueAt,
      prompt: 'p',
      personalityId: 'test',
      missedRunPolicy: 'run-once',
    });
    await patch(scheduler, job.id, { nextRunAt: dueAt });
    await scheduler.fire();
    expect((await scheduler.getJob(job.id))?.status).toBe('paused');

    fail = false;
    await scheduler.resumeJob(job.id);
    await scheduler.fire();
    const after = await scheduler.getJob(job.id);
    expect(runs).toHaveLength(2);
    expect(after?.status).toBe('done');
    expect(after?.runCount).toBe(1);
  });

  it('never delivers an empty output', async () => {
    const deliver = vi.fn(async (_job: CronJob, _text: string) => {});
    const scheduler = makeScheduler(async (job) => ok(job, '  '), { deliver });
    await scheduler.createJob({
      name: 'Empty',
      schedule: '0 8 * * *',
      prompt: 'p',
      personalityId: 'test',
      missedRunPolicy: 'skip',
      origin: { platform: 'telegram', chatId: '1' },
    });
    await scheduler.runJobNow('empty');
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('UBP-026 — no overlapping executions', () => {
  it('a due tick and runJobNow are refused while the previous run is executing', async () => {
    const { runJob, started, release, running } = blockingRunJob();
    const scheduler = makeScheduler(runJob);
    const job = await scheduler.createJob({
      name: 'Inbox triage',
      schedule: '*/5 * * * *',
      prompt: 'triage',
      personalityId: 'test',
      missedRunPolicy: 'run-once',
    });
    await patch(scheduler, job.id, { nextRunAt: new Date(Date.now() - 1_000).toISOString() });

    const first = scheduler.fire();
    await running;

    // The job comes due again while run #1 is still going.
    await patch(scheduler, job.id, { nextRunAt: new Date(Date.now() - 1_000).toISOString() });
    await scheduler.fire();
    expect(started).toEqual(['inbox-triage']);
    // Overlap is a skip: nextRunAt advanced, and a run record says why.
    const mid = await scheduler.getJob(job.id);
    expect(new Date(mid?.nextRunAt ?? 0).getTime()).toBeGreaterThan(Date.now());
    const runs = await scheduler.listRuns(job.id);
    expect(runs).toHaveLength(1);
    const body = runs[0] ? await scheduler.readRunOutput(runs[0].outputPath) : '';
    expect(body).toMatch(/skipped: overlap/);

    await expect(scheduler.runJobNow(job.id)).rejects.toThrow(/already running/);
    expect(started).toEqual(['inbox-triage']);

    release();
    await first;
    expect((await scheduler.getJob(job.id))?.runningSince ?? null).toBeNull();
  });

  it('keeps the running stamp after a timeout until the abandoned turn settles', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let settled = false;
    const scheduler = makeScheduler(async (job) => {
      await gate; // ignores the abort signal
      settled = true;
      return ok(job);
    });
    const job = await scheduler.createJob({
      name: 'Stuck',
      schedule: '0 8 * * *',
      prompt: 'p',
      personalityId: 'test',
      missedRunPolicy: 'run-once',
      maxRunMs: 30,
    });
    await patch(scheduler, job.id, { nextRunAt: new Date(Date.now() - 1_000).toISOString() });

    await scheduler.fire();
    const timedOut = await scheduler.getJob(job.id);
    expect(timedOut?.lastError).toMatch(/timed out/);
    expect(typeof timedOut?.runningSince).toBe('number');
    await expect(scheduler.runJobNow(job.id)).rejects.toThrow(/already running/);

    release();
    await vi.waitFor(async () => {
      expect(settled).toBe(true);
      expect((await scheduler.getJob(job.id))?.runningSince ?? null).toBeNull();
    });
  });
});

describe('UBP-027 — missed runs', () => {
  it('runs a skip-policy job due a few hundred ms past one tick interval', async () => {
    const runs: string[] = [];
    const scheduler = new CronScheduler({
      cronDir: testDir,
      scriptsDir: join(testDir, 'scripts'),
      storage: new FsStorage(),
      runJob: async (job) => {
        runs.push(job.id);
        return ok(job);
      },
    });
    const job = await scheduler.createJob({
      name: 'Boundary',
      schedule: '0 8 * * *',
      prompt: 'p',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    await patch(scheduler, job.id, { nextRunAt: new Date(Date.now() - 60_500).toISOString() });
    await scheduler.fire();
    expect(runs).toEqual(['boundary']);
  });

  it('a missed one-shot is retired with lastError and a missed notice, not silently', async () => {
    const deliver = vi.fn(async (_job: CronJob, _text: string) => {});
    const runs: string[] = [];
    const scheduler = makeScheduler(
      async (job) => {
        runs.push(job.id);
        return ok(job);
      },
      { deliver, tickIntervalMs: 60_000 },
    );
    const dueAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const job = await scheduler.createJob({
      name: 'Missed reminder',
      schedule: dueAt,
      prompt: 'p',
      personalityId: 'test',
      missedRunPolicy: 'skip',
      origin: { platform: 'telegram', chatId: '1' },
    });
    await patch(scheduler, job.id, { nextRunAt: dueAt });
    await scheduler.fire();

    const after = await scheduler.getJob(job.id);
    expect(runs).toEqual([]);
    expect(after?.status).toBe('done');
    expect(after?.lastError).toMatch(/missed/);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[1]).toMatch(/missed/);
  });

  it('a skipped recurring occurrence leaves a run record', async () => {
    const scheduler = makeScheduler(async (job) => ok(job), { tickIntervalMs: 60_000 });
    const job = await scheduler.createJob({
      name: 'Daily',
      schedule: '0 8 * * *',
      prompt: 'p',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    await patch(scheduler, job.id, { nextRunAt: new Date(Date.now() - 3_600_000).toISOString() });
    await scheduler.fire();
    const runs = await scheduler.listRuns(job.id);
    expect(runs).toHaveLength(1);
    const body = runs[0] ? await scheduler.readRunOutput(runs[0].outputPath) : '';
    expect(body).toMatch(/skipped: missed/);
  });

  it('a job deferred by maxParallelJobs is not dropped as missed', async () => {
    const { runJob, started, release, running } = blockingRunJob();
    const scheduler = makeScheduler(runJob, { maxParallelJobs: 1, tickIntervalMs: 50 });
    for (const name of ['Slot One', 'Slot Two']) {
      await scheduler.createJob({
        name,
        schedule: '0 8 * * *',
        prompt: 'p',
        personalityId: 'test',
        missedRunPolicy: 'skip',
      });
    }
    await patch(scheduler, 'slot-one', { nextRunAt: new Date(Date.now() - 10).toISOString() });
    const first = scheduler.fire();
    await running;
    // Slot two comes due while slot one holds the only slot.
    await patch(scheduler, 'slot-two', { nextRunAt: new Date(Date.now() - 10).toISOString() });
    await scheduler.fire(); // slot-two deferred at the cap
    await new Promise((r) => setTimeout(r, 300)); // well past the grace window
    release();
    await first;
    await scheduler.fire();
    expect(started).toEqual(['slot-one', 'slot-two']);
  });

  it('an external fire cadence longer than the tick interval does not skip due jobs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-10-01T08:00:00.000Z').getTime();
    vi.setSystemTime(t0);
    const runs: string[] = [];
    const scheduler = makeScheduler(
      async (job) => {
        runs.push(job.id);
        return ok(job);
      },
      { tickIntervalMs: 60_000 },
    );
    const job = await scheduler.createJob({
      name: 'Every ten',
      schedule: 'every 10m',
      prompt: 'p',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    // An external scheduler fires every 5 minutes.
    await scheduler.fire();
    vi.setSystemTime(t0 + 5 * 60_000);
    await scheduler.fire();
    // Due 4 minutes before the next external fire — inside its cadence.
    await patch(scheduler, job.id, { nextRunAt: new Date(t0 + 6 * 60_000).toISOString() });
    vi.setSystemTime(t0 + 10 * 60_000);
    await scheduler.fire();
    expect(runs).toEqual(['every-ten']);
  });
});

describe('UBP-029 — failure notice for a failed prompt job', () => {
  it('sends one rate-limited notice to the origin', async () => {
    const deliver = vi.fn(async (_job: CronJob, _text: string) => {});
    const scheduler = makeScheduler(
      async () => {
        throw new Error('provider outage');
      },
      { deliver },
    );
    const job = await scheduler.createJob({
      name: 'Briefing',
      schedule: '0 8 * * *',
      prompt: 'brief me',
      personalityId: 'test',
      missedRunPolicy: 'run-once',
      origin: { platform: 'telegram', chatId: '42' },
    });
    for (let i = 0; i < 2; i++) {
      await patch(scheduler, job.id, { nextRunAt: new Date(Date.now() - 1_000).toISOString() });
      await scheduler.fire();
    }
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[1]).toMatch(/Briefing.*failed.*provider outage/s);
    const after = await scheduler.getJob(job.id);
    expect(after?.lastError).toBe('provider outage');
  });
});

// UBP-027 (observability) — a skip is an audit decision too, so hosts that
// forward `onDecision` to `recordHeartbeatDecision` put misses and overlaps in
// observability.db alongside escalate/silent.
describe('UBP-027 — skips reach onDecision', () => {
  type Seen = { jobId: string; action: string; delivered: boolean };

  it('a skipped recurring occurrence reports action "missed"', async () => {
    const seen: Seen[] = [];
    const scheduler = makeScheduler(async (job) => ok(job), {
      tickIntervalMs: 60_000,
      onDecision: (job, d) =>
        seen.push({ jobId: job.id, action: d.action, delivered: d.delivered }),
    });
    const job = await scheduler.createJob({
      name: 'Daily',
      schedule: '0 8 * * *',
      prompt: 'p',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    await patch(scheduler, job.id, { nextRunAt: new Date(Date.now() - 3_600_000).toISOString() });
    await scheduler.fire();
    expect(seen).toEqual([{ jobId: 'daily', action: 'missed', delivered: false }]);
  });

  it('a missed one-shot reports "missed" with its notice delivered', async () => {
    const seen: Seen[] = [];
    const scheduler = makeScheduler(async (job) => ok(job), {
      tickIntervalMs: 60_000,
      deliver: async () => {},
      onDecision: (job, d) =>
        seen.push({ jobId: job.id, action: d.action, delivered: d.delivered }),
    });
    const dueAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const job = await scheduler.createJob({
      name: 'Missed reminder',
      schedule: dueAt,
      prompt: 'p',
      personalityId: 'test',
      missedRunPolicy: 'skip',
      origin: { platform: 'telegram', chatId: '1' },
    });
    await patch(scheduler, job.id, { nextRunAt: dueAt });
    await scheduler.fire();
    expect(seen).toEqual([{ jobId: 'missed-reminder', action: 'missed', delivered: true }]);
  });

  it('an overlapping occurrence reports action "overlap-skip"', async () => {
    const seen: Seen[] = [];
    const { runJob, release, running } = blockingRunJob();
    const scheduler = makeScheduler(runJob, {
      onDecision: (job, d) =>
        seen.push({ jobId: job.id, action: d.action, delivered: d.delivered }),
    });
    const job = await scheduler.createJob({
      name: 'Inbox triage',
      schedule: '*/5 * * * *',
      prompt: 'triage',
      personalityId: 'test',
      missedRunPolicy: 'run-once',
    });
    await patch(scheduler, job.id, { nextRunAt: new Date(Date.now() - 1_000).toISOString() });
    const first = scheduler.fire();
    await running;
    await patch(scheduler, job.id, { nextRunAt: new Date(Date.now() - 1_000).toISOString() });
    await scheduler.fire();
    expect(seen).toEqual([{ jobId: 'inbox-triage', action: 'overlap-skip', delivered: false }]);
    release();
    await first;
  });
});
