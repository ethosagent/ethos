import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CronScheduler } from '@ethosagent/cron';
import { FsStorage } from '@ethosagent/storage-fs';
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCronTool } from '../index';

// Item 1 (plan openclaw-advisory-fixes): every non-create cron action is
// scoped to the calling personality by loadOwnedJob, and another
// personality's job is indistinguishable from a nonexistent one.

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-cron-ownership-${Date.now()}-${Math.random()}`);
  await mkdir(join(testDir, 'scripts'), { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function makeScheduler() {
  return new CronScheduler({
    cronDir: testDir,
    scriptsDir: join(testDir, 'scripts'),
    tickIntervalMs: 999_999,
    storage: new FsStorage(),
    runJob: async (job) => ({
      jobId: job.id,
      ranAt: new Date().toISOString(),
      output: `ran: ${job.prompt}`,
      sessionKey: `cron:${job.id}`,
    }),
  });
}

function ctxFor(personalityId: string | undefined): ToolContext {
  return {
    sessionId: 's',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    ...(personalityId !== undefined ? { personalityId } : {}),
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  };
}

function toolOf(scheduler: CronScheduler): Tool {
  const [tool] = createCronTool(scheduler);
  if (!tool) throw new Error('expected tool');
  return tool;
}

function errorOf(r: ToolResult): string {
  if (r.ok) throw new Error(`expected refusal, got ok: ${r.value}`);
  return r.error;
}

/** Each non-create action with the args it needs to get past input validation. */
function actionArgs(id: string): Array<Record<string, unknown>> {
  return [
    { action: 'get', id },
    { action: 'read_run', id, at: '2026-01-01T00:00:00.000Z' },
    { action: 'update', id, name: 'Hijacked' },
    { action: 'pause', id },
    { action: 'resume', id },
    { action: 'run', id },
    { action: 'remove', id },
  ];
}

async function seedAJob(scheduler: CronScheduler) {
  const job = await scheduler.createJob({
    name: 'A Job',
    schedule: 'every 1h',
    prompt: 'do the A thing',
    personalityId: 'A',
    missedRunPolicy: 'skip',
  });
  // One real run so read_run on A's own job would have something to find.
  await scheduler.runJobNow(job.id);
  return job;
}

describe('cron tool ownership', () => {
  it("B's actions on A's job return the same not-found text as a nonexistent id", async () => {
    const scheduler = makeScheduler();
    const tool = toolOf(scheduler);
    const job = await seedAJob(scheduler);
    const before = await scheduler.getJob(job.id);
    const runSpy = vi.spyOn(scheduler, 'runJobNow');

    const onAJob: ToolResult[] = [];
    for (const args of actionArgs(job.id)) {
      const r = await tool.execute(args, ctxFor('B'));
      expect(errorOf(r)).toBe(`Job not found: ${job.id}`);
      onAJob.push(r);
    }

    expect(runSpy).not.toHaveBeenCalled();
    // A's job is untouched: not renamed, paused, or deleted.
    expect(await scheduler.getJob(job.id)).toEqual(before);

    // Now make the same id truly nonexistent and replay: B must not be able to
    // tell the two cases apart (no existence oracle).
    await scheduler.deleteJob(job.id);
    const onNothing: ToolResult[] = [];
    for (const args of actionArgs(job.id)) onNothing.push(await tool.execute(args, ctxFor('B')));
    expect(onAJob).toEqual(onNothing);
  });

  it("B cannot see A's job via list, with or without a personalityId filter", async () => {
    const scheduler = makeScheduler();
    const tool = toolOf(scheduler);
    const job = await seedAJob(scheduler);

    for (const args of [{ action: 'list' }, { action: 'list', personalityId: 'A' }]) {
      const r = await tool.execute(args, ctxFor('B'));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).not.toContain(job.id);
    }

    const own = await tool.execute({ action: 'list' }, ctxFor('A'));
    expect(own.ok && own.value).toContain(job.id);
  });

  it('A can still act on its own job', async () => {
    const scheduler = makeScheduler();
    const tool = toolOf(scheduler);
    const job = await seedAJob(scheduler);

    expect((await tool.execute({ action: 'get', id: job.id }, ctxFor('A'))).ok).toBe(true);
    expect((await tool.execute({ action: 'run', id: job.id }, ctxFor('A'))).ok).toBe(true);
    expect((await tool.execute({ action: 'remove', id: job.id }, ctxFor('A'))).ok).toBe(true);
    expect(await scheduler.getJob(job.id)).toBeNull();
  });

  it('a call with no personality context is refused for every action', async () => {
    const scheduler = makeScheduler();
    const tool = toolOf(scheduler);
    const job = await seedAJob(scheduler);
    const runSpy = vi.spyOn(scheduler, 'runJobNow');

    for (const args of [{ action: 'list' }, ...actionArgs(job.id)]) {
      const r = await tool.execute(args, ctxFor(undefined));
      expect(errorOf(r)).toBe('cron jobs require a personality context');
      expect(r.ok === false && r.code).toBe('input_invalid');
    }
    expect(runSpy).not.toHaveBeenCalled();
    expect(await scheduler.getJob(job.id)).not.toBeNull();
  });

  it("refuses update/pause/resume/run/remove on a source:'system' job the caller owns", async () => {
    const scheduler = makeScheduler();
    const tool = toolOf(scheduler);
    const job = await scheduler.seedSystemJob({
      name: 'Nightly Dream',
      schedule: '0 3 * * *',
      systemTask: 'dream',
      personalityId: 'A',
    });
    const before = await scheduler.getJob(job.id);
    const runSpy = vi.spyOn(scheduler, 'runJobNow');

    for (const [action, verb] of [
      ['update', 'update'],
      ['pause', 'pause'],
      ['resume', 'resume'],
      ['run', 'run'],
      ['remove', 'delete'],
    ] as const) {
      const args = action === 'update' ? { action, id: job.id, name: 'x' } : { action, id: job.id };
      const r = await tool.execute(args, ctxFor('A'));
      expect(errorOf(r)).toBe(`Cannot ${verb} system job — managed by operator config`);
    }
    expect(runSpy).not.toHaveBeenCalled();
    expect(await scheduler.getJob(job.id)).toEqual(before);
  });
});
