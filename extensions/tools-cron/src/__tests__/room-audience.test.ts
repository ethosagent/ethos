import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CronJob, CronScheduler } from '@ethosagent/cron';
import { FsStorage } from '@ethosagent/storage-fs';
import type { Tool, ToolContext, ToolResult, TurnAudience } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCronTool } from '../index';

// plan personality-memory-boundary G1 (verification round B13/B14) — a shared
// turn reads only jobs stamped shared (`readableFrom`), and a shared turn that
// edits or runs a job restamps it shared (`CronJobUpdate.roomAudience`), so a
// room can neither read a private job's output nor retarget a private job.

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-cron-audience-${Date.now()}-${Math.random()}`);
  await mkdir(join(testDir, 'scripts'), { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function harness() {
  const ran: CronJob[] = [];
  const scheduler = new CronScheduler({
    cronDir: testDir,
    scriptsDir: join(testDir, 'scripts'),
    tickIntervalMs: 999_999,
    storage: new FsStorage(),
    runJob: async (job) => {
      ran.push(job);
      return {
        jobId: job.id,
        ranAt: new Date().toISOString(),
        output: `private output of ${job.name}`,
        sessionKey: `cron:${job.id}`,
      };
    },
  });
  const [tool] = createCronTool(scheduler);
  if (!tool) throw new Error('expected tool');
  return { scheduler, tool: tool as Tool, ran };
}

function ctx(roomAudience: TurnAudience): ToolContext {
  return {
    sessionId: 's',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    personalityId: 'A',
    roomAudience,
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  };
}

function okValue(r: ToolResult): string {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
}

function errorOf(r: ToolResult): string {
  if (r.ok) throw new Error(`expected refusal, got ok: ${r.value}`);
  return r.error;
}

async function seed(scheduler: CronScheduler, name: string, roomAudience?: TurnAudience) {
  const job = await scheduler.createJob({
    name,
    schedule: 'every 1h',
    prompt: `do ${name}`,
    personalityId: 'A',
    missedRunPolicy: 'skip',
    ...(roomAudience ? { roomAudience } : {}),
  });
  const run = await scheduler.runJobNow(job.id);
  return { job, ranAt: run.ranAt };
}

describe('cron tool — room audience', () => {
  it('a shared turn cannot list, get or read_run a private or unstamped job', async () => {
    const { scheduler, tool } = harness();
    const priv = await seed(scheduler, 'Private', 'private');
    const legacy = await seed(scheduler, 'Legacy');
    const room = await seed(scheduler, 'Room', 'shared');

    const listed = okValue(await tool.execute({ action: 'list' }, ctx('shared')));
    expect(listed).toContain('Room');
    expect(listed).not.toContain('Private');
    expect(listed).not.toContain('Legacy');

    for (const { job, ranAt } of [priv, legacy]) {
      const notFound = `Job not found: ${job.id}`;
      expect(errorOf(await tool.execute({ action: 'get', id: job.id }, ctx('shared')))).toBe(
        notFound,
      );
      expect(
        errorOf(await tool.execute({ action: 'read_run', id: job.id, at: ranAt }, ctx('shared'))),
      ).toBe(notFound);
    }

    expect(
      okValue(
        await tool.execute({ action: 'read_run', id: room.job.id, at: room.ranAt }, ctx('shared')),
      ),
    ).toContain('private output of Room');
  });

  it('a private turn still reads every job it owns', async () => {
    const { scheduler, tool } = harness();
    const priv = await seed(scheduler, 'Private', 'private');
    expect(
      okValue(
        await tool.execute({ action: 'read_run', id: priv.job.id, at: priv.ranAt }, ctx('private')),
      ),
    ).toContain('private output of Private');
  });

  it('update from a shared turn restamps the job shared', async () => {
    const { scheduler, tool } = harness();
    const { job } = await seed(scheduler, 'Private', 'private');
    okValue(await tool.execute({ action: 'update', id: job.id, prompt: 'new' }, ctx('shared')));
    expect((await scheduler.getJob(job.id))?.roomAudience).toBe('shared');
  });

  it('update from a private turn leaves the stamp alone', async () => {
    const { scheduler, tool } = harness();
    const { job } = await seed(scheduler, 'Private', 'private');
    okValue(await tool.execute({ action: 'update', id: job.id, prompt: 'new' }, ctx('private')));
    expect((await scheduler.getJob(job.id))?.roomAudience).toBe('private');
  });

  // verification round E1: chaining from a private job is refused on a shared
  // turn, with the scheduler's own unknown-reference text and code, so the
  // refusal does not tell a private job from a missing one.
  it('create from a shared turn refuses context_from naming a private job, like a missing one', async () => {
    const { scheduler, tool } = harness();
    await seed(scheduler, 'Private', 'private');
    await seed(scheduler, 'Legacy');
    const room = await seed(scheduler, 'Room', 'shared');
    const create = (ref: string) =>
      tool.execute(
        {
          action: 'create',
          name: `c-${ref}`,
          schedule: 'every 1h',
          prompt: 'p',
          context_from: [ref],
        },
        ctx('shared'),
      );

    const missing = await create('no-such-job');
    expect(missing).toEqual({
      ok: false,
      error: 'contextFrom references unknown job: "no-such-job"',
      code: 'execution_failed',
    });
    for (const ref of ['private', 'Private', 'legacy']) {
      expect(await create(ref)).toEqual({
        ok: false,
        error: `contextFrom references unknown job: "${ref}"`,
        code: 'execution_failed',
      });
    }
    okValue(await create(room.job.id));
  });

  it('create from a private turn may chain from a private job', async () => {
    const { scheduler, tool } = harness();
    const priv = await seed(scheduler, 'Private', 'private');
    okValue(
      await tool.execute(
        {
          action: 'create',
          name: 'chained',
          schedule: 'every 1h',
          prompt: 'p',
          context_from: [priv.job.id],
        },
        ctx('private'),
      ),
    );
  });

  it('run from a shared turn restamps the job BEFORE it runs', async () => {
    const { scheduler, tool, ran } = harness();
    const { job } = await seed(scheduler, 'Private', 'private');
    okValue(await tool.execute({ action: 'run', id: job.id }, ctx('shared')));
    expect(ran.at(-1)?.roomAudience).toBe('shared');
    expect((await scheduler.getJob(job.id))?.roomAudience).toBe('shared');
  });
});
