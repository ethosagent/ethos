/**
 * UBP-004 — `ethos gateway start` and `ethos cron run` fire cron turns through
 * `createCronRunJob` (apps/ethos/src/commands/cron-turn.ts), the adapter onto
 * the one turn implementation, `runCronTurn`. A turn that yields
 * `{type:'error', code:'llm_error'}` and no `done` (AgentLoop's fatal-step
 * path) must fail the run: the scheduler records `lastError`, does not count
 * it, and does not retire a one-shot.
 */

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CronScheduler } from '@ethosagent/cron';
import { FsStorage } from '@ethosagent/storage-fs';
import type { AgentEvent } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCronRunJob } from '../commands/cron-turn';

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `ethos-cron-host-${Date.now()}-${Math.random()}`);
  await mkdir(join(dir, 'scripts'), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeLoop(events: AgentEvent[]) {
  return {
    run() {
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
  };
}

function scheduler(
  events: AgentEvent[],
  deliver = vi.fn(async (_job: { id: string }, _text: string) => {}),
) {
  const toolsetFor = vi.fn(async () => ['web_search', 'cron']);
  return {
    deliver,
    scheduler: new CronScheduler({
      cronDir: dir,
      scriptsDir: join(dir, 'scripts'),
      tickIntervalMs: 999_999,
      storage: new FsStorage(),
      deliver,
      runJob: createCronRunJob({
        loop: () => fakeLoop(events),
        toolsetFor,
        audienceFor: async () => 'private',
      }),
    }),
  };
}

const llmError: AgentEvent[] = [
  { type: 'text_delta', text: 'Here is the start of your bri' },
  { type: 'error', error: 'provider returned HTTP 500', code: 'llm_error' },
];

describe('createCronRunJob — the gateway / `ethos cron run` runJob', () => {
  it('runJobNow rejects and records lastError on an llm_error turn', async () => {
    const { scheduler: s, deliver } = scheduler(llmError);
    const job = await s.createJob({
      name: 'Bank reminder',
      schedule: '2099-01-01T09:00:00Z',
      prompt: 'remind me to call the bank',
      personalityId: 'researcher',
      missedRunPolicy: 'run-once',
      origin: { platform: 'telegram', chatId: '42' },
    });

    await expect(s.runJobNow(job.id)).rejects.toThrow(/llm_error/);
    const after = await s.getJob(job.id);
    expect(after?.lastError).toMatch(/llm_error/);
    expect(after?.status).toBe('active');
    expect(after?.runCount).toBe(0);
    // The partial text was not delivered as if it were the briefing.
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a scheduled one-shot whose turn fails is not retired or counted', async () => {
    const { scheduler: s, deliver } = scheduler(llmError);
    const dueAt = new Date(Date.now() - 5_000).toISOString();
    const job = await s.createJob({
      name: 'Morning call',
      schedule: dueAt,
      prompt: 'remind me',
      personalityId: 'researcher',
      missedRunPolicy: 'run-once',
      origin: { platform: 'telegram', chatId: '42' },
    });
    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (s as any).patchJob(job.id, { nextRunAt: dueAt });

    await s.fire();
    const after = await s.getJob(job.id);
    expect(after?.lastError).toMatch(/llm_error/);
    expect(after?.runCount).toBe(0);
    expect(after?.status).not.toBe('done');
    // Only the failure notice reaches the chat — never the partial output.
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[1]).toMatch(/failed/);
  });

  it('passes the host toolset and room audience through and delivers only the final answer', async () => {
    const seen: { toolsetOverride?: string[]; roomAudience?: string; initiator?: string }[] = [];
    const deliver = vi.fn(async () => {});
    const s = new CronScheduler({
      cronDir: dir,
      scriptsDir: join(dir, 'scripts'),
      tickIntervalMs: 999_999,
      storage: new FsStorage(),
      deliver,
      runJob: createCronRunJob({
        toolsetFor: async () => ['web_search'],
        // plan personality-memory-boundary G1-9 — the host's audience reaches the turn.
        audienceFor: async () => 'shared',
        loop: () => ({
          run(
            _t: string,
            opts: { toolsetOverride?: string[]; roomAudience?: string; initiator?: string },
          ) {
            seen.push(opts);
            return (async function* (): AsyncGenerator<AgentEvent> {
              yield { type: 'text_delta', text: 'Checking.' };
              yield { type: 'tool_start', toolCallId: 'a', toolName: 'web_search', args: {} };
              yield { type: 'text_delta', text: 'Pipeline: 3 new leads.' };
              yield { type: 'done', text: 'Checking.Pipeline: 3 new leads.', turnCount: 2 };
            })();
          },
        }),
      }),
    });
    const job = await s.createJob({
      name: 'Pipeline',
      schedule: '0 8 * * *',
      prompt: 'summarise',
      personalityId: 'sales',
      missedRunPolicy: 'skip',
      origin: { platform: 'telegram', chatId: '42' },
    });
    const result = await s.runJobNow(job.id);
    expect(seen[0]?.toolsetOverride).toEqual(['web_search']);
    expect(seen[0]).toMatchObject({ roomAudience: 'shared', initiator: 'system' });
    expect(result.output).toBe('Pipeline: 3 new leads.');
    expect(deliver).toHaveBeenCalledWith(expect.anything(), 'Pipeline: 3 new leads.');
    const runs = await s.listRuns(job.id);
    const body = runs[0] ? await s.readRunOutput(runs[0].outputPath) : '';
    expect(body).toContain('Checking.Pipeline: 3 new leads.');
  });
});
