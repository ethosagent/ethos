import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CronScheduler } from '@ethosagent/cron';
import { FsStorage } from '@ethosagent/storage-fs';
import type { ToolContext } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentLoop } from '../index';

// UBP-024 (thread half), end to end through the composition root: the gateway
// hosts hand every loop `resolveOriginThreadId` (`gatewayTurnOrigin` →
// `Gateway.originThreadIdFor`, apps/ethos/src/commands/gateway.ts), and
// `composeTools` must forward it to the cron tool. Before the fix only the
// background-job deps received it, so a cron job created inside a Slack thread
// or Telegram topic recorded no `origin.threadId` and delivered to the chat root.

describe('cron tool records the thread through createAgentLoop (UBP-024)', () => {
  let home: string;
  const prev: Record<string, string | undefined> = {};

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ethos-cron-thread-'));
    mkdirSync(join(home, '.ethos', 'cron', 'scripts'), { recursive: true });
    for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prev[key] = process.env[key];
    process.env.HOME = home;
    process.env.ETHOS_STATE_DIR = join(home, '.ethos');
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('a job created in a thread stores origin.threadId from the host resolver', async () => {
    const scheduler = new CronScheduler({
      cronDir: join(home, '.ethos', 'cron'),
      scriptsDir: join(home, '.ethos', 'cron', 'scripts'),
      tickIntervalMs: 999_999,
      storage: new FsStorage(),
      runJob: async (job) => ({
        jobId: job.id,
        ranAt: new Date().toISOString(),
        output: '',
        sessionKey: `cron:${job.id}`,
      }),
    });
    const asked: string[] = [];
    const runtime = await createAgentLoop(
      { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-test' },
      {
        dataDir: join(home, '.ethos'),
        workingDir: home,
        profile: 'cli',
        disableDocker: true,
        cronScheduler: scheduler,
        resolveOriginThreadId: (sessionKey) => {
          asked.push(sessionKey);
          return 'thread-9';
        },
      },
    );
    try {
      const tool = runtime.toolRegistry.get('cron');
      if (!tool) throw new Error('expected the cron tool to be registered');
      const ctx: ToolContext = {
        sessionId: 's1',
        sessionKey: 'slack:bot-a:C123',
        platform: 'slack',
        workingDir: home,
        personalityId: 'researcher',
        currentTurn: 1,
        messageCount: 1,
        abortSignal: new AbortController().signal,
        emit: () => {},
        resultBudgetChars: 80_000,
      };
      const result = await tool.execute(
        { action: 'create', name: 'Digest', schedule: '0 8 * * *', prompt: 'summarise' },
        ctx,
      );
      expect(result.ok).toBe(true);
      expect(asked).toEqual(['slack:bot-a:C123']);
      expect((await scheduler.getJob('digest'))?.origin).toEqual({
        platform: 'slack',
        chatId: 'C123',
        botKey: 'bot-a',
        threadId: 'thread-9',
      });
    } finally {
      await runtime.dispose();
    }
  });
});
