import type { CronScheduler, CronJob as ExtCronJob } from '@ethosagent/cron';
import { describe, expect, it, vi } from 'vitest';
import { CronService } from '../cron.service';

// The service wraps the scheduler; we assert the in-app-heartbeat flag maps to
// a `web` origin and its absence keeps today's file-only behaviour (no origin).

function makeJob(params: Partial<ExtCronJob>): ExtCronJob {
  return {
    id: 'daily-news',
    name: 'daily-news',
    schedule: '0 9 * * *',
    prompt: 'do the thing',
    personalityId: 'scout',
    status: 'active',
    missedRunPolicy: 'skip',
    repeat: { kind: 'forever' },
    runCount: 0,
    createdAt: new Date().toISOString(),
    ...params,
  } as ExtCronJob;
}

function makeService() {
  const createJob = vi.fn(async (params: Parameters<CronScheduler['createJob']>[0]) =>
    makeJob(params as Partial<ExtCronJob>),
  );
  const svc = new CronService({ scheduler: { createJob } as unknown as CronScheduler });
  return { svc, createJob };
}

describe('CronService.create', () => {
  it('gives the job a web origin when notifyInApp is true', async () => {
    const { svc, createJob } = makeService();

    await svc.create({
      name: 'daily-news',
      schedule: '0 9 * * *',
      prompt: 'summarize',
      personalityId: 'scout',
      notifyInApp: true,
    });

    expect(createJob).toHaveBeenCalledTimes(1);
    expect(createJob.mock.calls[0]?.[0].origin).toEqual({
      platform: 'web',
      chatId: 'web:heartbeat:scout',
    });
  });

  it('passes no origin when notifyInApp is false', async () => {
    const { svc, createJob } = makeService();

    await svc.create({
      name: 'daily-news',
      schedule: '0 9 * * *',
      prompt: 'summarize',
      personalityId: 'scout',
      notifyInApp: false,
    });

    expect(createJob.mock.calls[0]?.[0].origin).toBeUndefined();
  });

  it('passes no origin when notifyInApp is absent', async () => {
    const { svc, createJob } = makeService();

    await svc.create({
      name: 'daily-news',
      schedule: '0 9 * * *',
      prompt: 'summarize',
      personalityId: 'scout',
    });

    expect(createJob.mock.calls[0]?.[0].origin).toBeUndefined();
  });
});
