// plan personality-memory-boundary step 5 — a cron firing's room audience
// reaches `AgentLoop.run`: `cronFiringAudience` (the rule every runner calls)
// and `runCronTurn` (serve/boot's turn shape). The gateway and `ethos cron run`
// runners pass the same `cronFiringAudience` result inline.

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateChatSetFrom } from '@ethosagent/core';
import { type CronJob, CronScheduler } from '@ethosagent/cron';
import { FsStorage } from '@ethosagent/storage-fs';
import type { AgentEvent, TurnAudience, TurnInitiator } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cronContextAudience, cronFiringAudience, runCronTurn } from '../commands/cron-turn';

interface Call {
  sessionKey: string;
  roomAudience: TurnAudience;
  initiator: TurnInitiator;
}

function makeLoop() {
  const calls: Call[] = [];
  return {
    calls,
    run(
      _text: string,
      opts: { sessionKey: string; roomAudience: TurnAudience; initiator: TurnInitiator },
    ) {
      calls.push({
        sessionKey: opts.sessionKey,
        roomAudience: opts.roomAudience,
        initiator: opts.initiator,
      });
      return (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'done', text: 'ok', turnCount: 1 };
      })();
    },
  };
}

const noSessions = { getSessionByKey: async () => null };

let dir: string;
beforeEach(async () => {
  dir = join(tmpdir(), `ethos-cron-audience-${Date.now()}-${Math.random()}`);
  await mkdir(join(dir, 'scripts'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function scheduler(): CronScheduler {
  return new CronScheduler({
    storage: new FsStorage(),
    cronDir: dir,
    scriptsDir: join(dir, 'scripts'),
    runJob: async (job) => ({ jobId: job.id, ranAt: '', output: '', sessionKey: '' }),
  });
}

/**
 * A job as the `cron` tool writes it (`handleCreate` in @ethosagent/tools-cron —
 * origin from the session key, `roomAudience` from the creating turn; pinned by
 * the stamp cases in extensions/tools-cron/src/__tests__/cron-tool.test.ts).
 */
async function createVia(
  sched: CronScheduler,
  name: string,
  from: { origin?: CronJob['origin']; roomAudience?: TurnAudience; contextFrom?: string[] },
) {
  return sched.createJob({
    name,
    schedule: '0 8 * * *',
    prompt: 'Summarize the news',
    personalityId: 'researcher',
    missedRunPolicy: 'skip',
    ...(from.origin ? { origin: from.origin } : {}),
    ...(from.roomAudience ? { roomAudience: from.roomAudience } : {}),
    ...(from.contextFrom ? { contextFrom: from.contextFrom } : {}),
  });
}

async function fire(sched: CronScheduler, job: CronJob, warn: (l: string) => void = () => {}) {
  const loop = makeLoop();
  const roomAudience = await cronFiringAudience(job, {
    listJobs: () => sched.listJobs(),
    warn,
  });
  const webOrigin = job.origin?.platform === 'web' ? job.origin.chatId : null;
  const result = await runCronTurn({
    loop,
    sessions: noSessions,
    jobId: job.id,
    prompt: job.prompt ?? '',
    personalityId: job.personalityId,
    webOrigin,
    roomAudience,
  });
  return { call: loop.calls[0], result };
}

describe('cron firing audience, end to end through runCronTurn', () => {
  it('a job created in a group chat runs shared, initiator system', async () => {
    const sched = scheduler();
    const job = await createVia(sched, 'group', {
      origin: { platform: 'telegram', chatId: '-100200' },
      roomAudience: 'shared',
    });
    const { call } = await fire(sched, job);
    expect(call).toMatchObject({ roomAudience: 'shared', initiator: 'system' });
  });

  it('a job created from the CLI runs private', async () => {
    const sched = scheduler();
    const job = await createVia(sched, 'cli', { roomAudience: 'private' });
    const { call } = await fire(sched, job);
    expect(call).toMatchObject({ roomAudience: 'private', initiator: 'system' });
  });

  it('a web-created job delivering to a group runs shared', async () => {
    const sched = scheduler();
    // What `CronService.create` writes for a `kind: 'channel'` target.
    const job = await sched.createJob({
      name: 'web-to-group',
      schedule: '0 8 * * *',
      prompt: 'Post the digest',
      personalityId: 'researcher',
      missedRunPolicy: 'skip',
      origin: { platform: 'slack', chatId: 'C0GROUP' },
      roomAudience: 'shared',
    });
    const { call } = await fire(sched, job);
    expect(call?.roomAudience).toBe('shared');
  });

  it('a job whose contextFrom names a group-created job runs shared', async () => {
    const sched = scheduler();
    await createVia(sched, 'group-digest', {
      origin: { platform: 'telegram', chatId: '-100200' },
      roomAudience: 'shared',
    });
    const reader = await createVia(sched, 'reader', {
      roomAudience: 'private',
      contextFrom: ['group-digest'],
    });
    const { call } = await fire(sched, reader);
    expect(call?.roomAudience).toBe('shared');
  });

  it('a legacy (unstamped) group job runs shared and logs the workaround once', async () => {
    const sched = scheduler();
    const job = await sched.createJob({
      name: 'legacy',
      schedule: '0 8 * * *',
      prompt: 'old',
      personalityId: 'researcher',
      missedRunPolicy: 'skip',
      origin: { platform: 'telegram', chatId: '-100200' },
    });
    const lines: string[] = [];
    const { call } = await fire(sched, job, (l) => lines.push(l));
    expect(call?.roomAudience).toBe('shared');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('gateway.private_chats');
  });

  it('listing the legacy job’s chat in gateway.private_chats restores private', async () => {
    const sched = scheduler();
    const job = await sched.createJob({
      name: 'legacy-listed',
      schedule: '0 8 * * *',
      prompt: 'old',
      personalityId: 'researcher',
      missedRunPolicy: 'skip',
      origin: { platform: 'discord', chatId: '99' },
    });
    const audience = await cronFiringAudience(job, {
      listJobs: () => sched.listJobs(),
      privateChats: privateChatSetFrom({ discord: ['99'] }),
      warn: () => {},
    });
    expect(audience).toBe('private');
  });

  it('a shared firing never reuses the owner’s web chat session', async () => {
    const sched = scheduler();
    const job = await sched.createJob({
      name: 'web-shared',
      schedule: '0 8 * * *',
      prompt: 'p',
      personalityId: 'researcher',
      missedRunPolicy: 'skip',
      origin: { platform: 'web', chatId: 'web:owner-chat' },
      roomAudience: 'shared',
    });
    const { call, result } = await fire(sched, job);
    expect(call?.roomAudience).toBe('shared');
    expect(result.reusedWebOrigin).toBe(false);
    expect(call?.sessionKey.startsWith('cron:web-shared:')).toBe(true);
  });

  it('a private web-origin firing still reuses the web chat session', async () => {
    const sched = scheduler();
    const job = await sched.createJob({
      name: 'web-private',
      schedule: '0 8 * * *',
      prompt: 'p',
      personalityId: 'researcher',
      missedRunPolicy: 'skip',
      origin: { platform: 'web', chatId: 'web:owner-chat' },
      roomAudience: 'private',
    });
    const { call, result } = await fire(sched, job);
    expect(result.reusedWebOrigin).toBe(true);
    expect(call).toMatchObject({ sessionKey: 'web:owner-chat', roomAudience: 'private' });
  });
});

// verification round E1 — every host passes `cronContextAudience` as the
// scheduler's `runAudience`, so a firing that runs shared by its delivery
// target alone (no stamp) still reads no private job's output.
describe('cronContextAudience as the scheduler runAudience', () => {
  it('an unstamped group-target job does not read a private job’s output', async () => {
    const prompts: string[] = [];
    const sched = new CronScheduler({
      storage: new FsStorage(),
      cronDir: dir,
      scriptsDir: join(dir, 'scripts'),
      runAudience: cronContextAudience(),
      runJob: async (job) => {
        prompts.push(job.prompt ?? '');
        return {
          jobId: job.id,
          ranAt: new Date().toISOString(),
          output: `out:${job.id}`,
          sessionKey: '',
        };
      },
    });
    const source = await createVia(sched, 'private-source', { roomAudience: 'private' });
    await sched.runJobNow(source.id);
    const chained = await createVia(sched, 'group-digest', {
      origin: { platform: 'telegram', chatId: '-100200' },
      contextFrom: [source.id],
    });
    await sched.runJobNow(chained.id);
    expect(prompts.at(-1)).not.toContain(`out:${source.id}`);

    const privateChained = await createVia(sched, 'dm-digest', {
      roomAudience: 'private',
      contextFrom: [source.id],
    });
    await sched.runJobNow(privateChained.id);
    expect(prompts.at(-1)).toContain(`out:${source.id}`);
  });

  it('honours gateway.private_chats for the firing job’s target', async () => {
    const job = await createVia(scheduler(), 'discord-job', {
      origin: { platform: 'discord', chatId: '99' },
    });
    expect(cronContextAudience()(job, [])).toBe('shared');
    expect(cronContextAudience(privateChatSetFrom({ discord: ['99'] }))(job, [])).toBe('private');
  });
});
