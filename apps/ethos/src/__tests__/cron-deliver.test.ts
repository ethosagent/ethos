// B-T5 (plan/phases/trust-before-reach.md) — ONE cron delivery path for both
// gateway-role commands.
//
// `ethos gateway start` re-checked the job's bot binding and threw on a failed
// send; `ethos boot`'s copy did neither, so under boot a job whose bot had left
// config delivered through whatever adapter was registered for the platform,
// and a failure left no `lastError` anywhere. These tests run the factory both
// commands now use, and the last one pins that they both use it.

import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CronScheduler } from '@ethosagent/cron';
import { FsStorage } from '@ethosagent/storage-fs';
import { isEthosError } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChannelSpeakers, createCronDeliver } from '../lib/cron-deliver';

function gatewayStub(result: { ok: boolean; error?: string } = { ok: true }) {
  return { sendTo: vi.fn(async () => result) };
}

/** Nothing on any platform speaks for any personality. */
const NO_BOTS: ChannelSpeakers = () => false;
const ALL_BOTS: ChannelSpeakers = () => true;

describe('createCronDeliver', () => {
  it('refuses with CRON_TARGET_NOT_ALLOWED when no bot is bound, and sends nothing', async () => {
    const gateway = gatewayStub();
    const deliver = createCronDeliver({ gateway, speaksFor: NO_BOTS });

    const err = await deliver(
      { personalityId: 'scout', origin: { platform: 'telegram', chatId: 'C9' } },
      'the digest',
    ).catch((e: unknown) => e);

    expect(isEthosError(err)).toBe(true);
    if (!isEthosError(err)) return;
    expect(err.code).toBe('CRON_TARGET_NOT_ALLOWED');
    expect(err.message).toContain('scout');
    expect(gateway.sendTo).not.toHaveBeenCalled();
  });

  it('throws NETWORK_ERROR when the send fails, so the scheduler can record it', async () => {
    const gateway = gatewayStub({ ok: false, error: 'chat not found' });
    const deliver = createCronDeliver({ gateway, speaksFor: ALL_BOTS });

    const err = await deliver(
      { personalityId: 'scout', origin: { platform: 'telegram', chatId: 'C9' } },
      'the digest',
    ).catch((e: unknown) => e);

    expect(isEthosError(err)).toBe(true);
    if (!isEthosError(err)) return;
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.message).toContain('chat not found');
  });

  it('delivers a bound job', async () => {
    const gateway = gatewayStub();
    const deliver = createCronDeliver({ gateway, speaksFor: ALL_BOTS });

    await deliver(
      { personalityId: 'scout', origin: { platform: 'telegram', chatId: 'C9' } },
      'the digest',
    );

    expect(gateway.sendTo).toHaveBeenCalledWith('telegram', 'C9', 'the digest');
  });

  it('does not gate a web origin on a channel binding — web has no bot', async () => {
    const gateway = gatewayStub();
    const deliver = createCronDeliver({ gateway, speaksFor: NO_BOTS });

    await deliver({ personalityId: 'scout', origin: { platform: 'web', chatId: 's-1' } }, 'out');

    expect(gateway.sendTo).toHaveBeenCalledWith('web', 's-1', 'out');
  });

  it('delivers nothing for a file-only job', async () => {
    const gateway = gatewayStub();
    const deliver = createCronDeliver({ gateway, speaksFor: ALL_BOTS });

    await deliver({ personalityId: 'scout' }, 'out');

    expect(gateway.sendTo).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Through the real scheduler: the throw is what puts the refusal on the job.
// ---------------------------------------------------------------------------

describe('createCronDeliver under CronScheduler', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `ethos-cron-deliver-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(join(testDir, 'scripts'), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  function scheduler(speaksFor: ChannelSpeakers, send: { ok: boolean; error?: string }) {
    const gateway = gatewayStub(send);
    return {
      gateway,
      cron: new CronScheduler({
        cronDir: testDir,
        scriptsDir: join(testDir, 'scripts'),
        tickIntervalMs: 999_999,
        storage: new FsStorage(),
        runJob: async (job) => ({
          jobId: job.id,
          ranAt: new Date().toISOString(),
          output: 'the digest',
          sessionKey: `cron:${job.id}`,
        }),
        deliver: createCronDeliver({ gateway, speaksFor }),
      }),
    };
  }

  it('records the unbound-bot refusal as the job’s lastError', async () => {
    const { cron, gateway } = scheduler(NO_BOTS, { ok: true });
    const job = await cron.createJob({
      name: 'digest',
      schedule: '0 8 * * *',
      prompt: 'summarize',
      personalityId: 'scout',
      missedRunPolicy: 'skip',
      origin: { platform: 'telegram', chatId: 'C9' },
    });

    await cron.runJobNow(job.id);

    expect(gateway.sendTo).not.toHaveBeenCalled();
    expect((await cron.getJob(job.id))?.lastError).toContain(
      'no telegram bot is bound to personality "scout"',
    );
  });

  it('records a failed send as the job’s lastError', async () => {
    const { cron } = scheduler(ALL_BOTS, { ok: false, error: 'chat not found' });
    const job = await cron.createJob({
      name: 'digest',
      schedule: '0 8 * * *',
      prompt: 'summarize',
      personalityId: 'scout',
      missedRunPolicy: 'skip',
      origin: { platform: 'telegram', chatId: 'C9' },
    });

    await cron.runJobNow(job.id);

    expect((await cron.getJob(job.id))?.lastError).toContain('chat not found');
  });
});

// ---------------------------------------------------------------------------
// Drift guard: two copies is what caused this.
// ---------------------------------------------------------------------------

describe('both gateway-role commands use the one factory', () => {
  for (const file of ['gateway.ts', 'boot.ts']) {
    it(`${file} builds its cron deliver with createCronDeliver`, () => {
      const src = readFileSync(join(import.meta.dirname, '..', 'commands', file), 'utf-8');
      expect(src).toContain('cronDeliverFn = createCronDeliver({');
      // The hand-rolled copy this replaced.
      expect(src).not.toContain('await gateway.sendTo(job.origin');
    });
  }
});
