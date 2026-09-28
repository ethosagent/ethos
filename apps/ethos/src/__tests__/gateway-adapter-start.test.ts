/**
 * UBP-010 — one adapter whose `start()` rejects (a revoked Discord token, a
 * network blip) must not take every other platform down with it. Both
 * adapter-owning commands start adapters through `startAdaptersIsolated`
 * (apps/ethos/src/commands/gateway.ts): the failure is logged and recorded as
 * `gateway.adapter_start_failed`, the rest keep running, and the command fails
 * only when EVERY adapter failed.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  adapterStartRetryDelayMs,
  isPermanentAdapterStartError,
  startAdaptersIsolated,
} from '../commands/gateway';

function adapter(id: string, fail?: string) {
  return {
    id,
    started: false,
    async start() {
      if (fail) throw new Error(fail);
      this.started = true;
    },
  };
}

describe('startAdaptersIsolated', () => {
  it('keeps the healthy adapter started when a sibling rejects', async () => {
    const telegram = adapter('telegram:ops');
    const discord = adapter('discord:ops', 'TokenInvalid');
    const recordSafetyBlock = vi.fn();
    const warn = vi.fn();

    const result = await startAdaptersIsolated([telegram, discord], {
      observability: { recordSafetyBlock },
      warn,
    });

    expect(telegram.started).toBe(true);
    expect(result.started).toEqual(['telegram:ops']);
    expect(result.failed).toEqual([{ id: 'discord:ops', error: 'TokenInvalid' }]);
    expect(recordSafetyBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'gateway.adapter_start_failed',
        details: expect.objectContaining({ adapterId: 'discord:ops' }),
      }),
    );
    expect(warn.mock.calls[0]?.[0]).toMatch(/discord:ops.*TokenInvalid/);
  });

  it('rejects when every adapter failed, so the process still exits', async () => {
    await expect(
      startAdaptersIsolated([adapter('discord:a', 'TokenInvalid'), adapter('slack:b', 'down')], {
        observability: { recordSafetyBlock: () => {} },
        warn: () => {},
      }),
    ).rejects.toThrow('TokenInvalid');
  });

  it('resolves for no adapters at all', async () => {
    const result = await startAdaptersIsolated([], {
      observability: { recordSafetyBlock: () => {} },
      warn: () => {},
    });
    expect(result).toMatchObject({ started: [], failed: [] });
  });

  // V-CC-4 — a failed adapter is retried in the background with capped,
  // jittered exponential backoff until it starts, fails permanently, or the
  // gateway shuts down.
  describe('background retry', () => {
    /** Fails its first `failures` starts with `error`, then starts. */
    function flaky(id: string, failures: number, error = 'ECONNRESET') {
      return {
        id,
        attempts: 0,
        started: false,
        stopped: false,
        async start() {
          this.attempts++;
          if (this.attempts <= failures) throw new Error(error);
          this.started = true;
        },
        async stop() {
          this.stopped = true;
        },
      };
    }
    const instantSleep = async (_ms: number, signal: AbortSignal) => !signal.aborted;

    it('retries a transiently failing adapter until it starts, one event per attempt', async () => {
      const telegram = adapter('telegram:ops');
      const discord = flaky('discord:ops', 3); // the initial start + 2 retries fail
      const recordSafetyBlock = vi.fn();
      const warn = vi.fn();
      const onStarted = vi.fn();
      const delays: number[] = [];
      const result = await startAdaptersIsolated([telegram, discord], {
        observability: { recordSafetyBlock },
        warn,
        retry: {
          signal: new AbortController().signal,
          onStarted,
          random: () => 0.5,
          sleep: async (ms, signal) => {
            delays.push(ms);
            return instantSleep(ms, signal);
          },
        },
      });
      expect(result.failed.map((f) => f.id)).toEqual(['discord:ops']);
      await result.retrying;
      expect(discord.started).toBe(true);
      expect(discord.attempts).toBe(4);
      expect(delays).toEqual([5_000, 10_000, 20_000]);
      expect(onStarted).toHaveBeenCalledWith(discord);
      const codes = recordSafetyBlock.mock.calls.map((c) => c[0].code);
      expect(codes).toEqual([
        'gateway.adapter_start_failed',
        'gateway.adapter_start_retry_failed',
        'gateway.adapter_start_retry_failed',
        'gateway.adapter_start_recovered',
      ]);
      expect(warn.mock.calls.at(-1)?.[0]).toMatch(/discord:ops started on retry 3/);
    });

    it('does not retry a permanent failure (a revoked token)', async () => {
      const discord = flaky('discord:ops', 99, 'An invalid token was provided. (TokenInvalid)');
      const recordSafetyBlock = vi.fn();
      const result = await startAdaptersIsolated([adapter('telegram:ops'), discord], {
        observability: { recordSafetyBlock },
        warn: () => {},
        retry: { signal: new AbortController().signal, sleep: instantSleep },
      });
      await result.retrying;
      expect(discord.attempts).toBe(1);
      expect(recordSafetyBlock.mock.calls.map((c) => c[0].code)).toEqual([
        'gateway.adapter_start_failed',
        'gateway.adapter_start_abandoned',
      ]);
    });

    it('stops retrying when a retry fails permanently', async () => {
      let attempts = 0;
      const slack = {
        id: 'slack:ops',
        async start() {
          attempts++;
          throw new Error(
            attempts === 1 ? 'socket hang up' : 'An API error occurred: invalid_auth',
          );
        },
      };
      const result = await startAdaptersIsolated([adapter('telegram:ops'), slack], {
        observability: { recordSafetyBlock: () => {} },
        warn: () => {},
        retry: { signal: new AbortController().signal, sleep: instantSleep },
      });
      await result.retrying;
      expect(attempts).toBe(2);
    });

    it('stops retrying on shutdown, and stops an adapter that started after it', async () => {
      const controller = new AbortController();
      const discord = flaky('discord:ops', 1);
      const result = await startAdaptersIsolated([adapter('telegram:ops'), discord], {
        observability: { recordSafetyBlock: () => {} },
        warn: () => {},
        retry: {
          signal: controller.signal,
          sleep: async () => {
            controller.abort();
            return true; // the timer fired just as shutdown began
          },
        },
      });
      await result.retrying;
      // Aborted before the attempt: never started again.
      expect(discord.attempts).toBe(1);
      expect(discord.started).toBe(false);
    });

    it('does not retry an adapter a config reload retired', async () => {
      const discord = flaky('discord:ops', 1);
      const result = await startAdaptersIsolated([adapter('telegram:ops'), discord], {
        observability: { recordSafetyBlock: () => {} },
        warn: () => {},
        retry: {
          signal: new AbortController().signal,
          sleep: instantSleep,
          isRetired: (a) => a === discord,
        },
      });
      await result.retrying;
      expect(discord.attempts).toBe(1);
    });

    it('never retries once the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const discord = flaky('discord:ops', 1);
      const result = await startAdaptersIsolated([adapter('telegram:ops'), discord], {
        observability: { recordSafetyBlock: () => {} },
        warn: () => {},
        retry: { signal: controller.signal },
      });
      await result.retrying;
      expect(discord.attempts).toBe(1);
    });
  });

  it('adapterStartRetryDelayMs doubles from 5s, caps at 5min, and jitters by ±20%', () => {
    expect(adapterStartRetryDelayMs(1, () => 0.5)).toBe(5_000);
    expect(adapterStartRetryDelayMs(2, () => 0.5)).toBe(10_000);
    expect(adapterStartRetryDelayMs(20, () => 0.5)).toBe(300_000);
    expect(adapterStartRetryDelayMs(1, () => 0)).toBe(4_000);
    expect(adapterStartRetryDelayMs(20, () => 1)).toBe(360_000);
  });

  it('isPermanentAdapterStartError recognises revoked and invalid credentials', () => {
    for (const permanent of [
      new Error('An invalid token was provided.'),
      Object.assign(new Error('x'), { code: 'TokenInvalid' }),
      Object.assign(new Error('Call to getMe failed! (401: Unauthorized)'), { error_code: 401 }),
      new Error('An API error occurred: invalid_auth'),
      new Error('An API error occurred: token_revoked'),
      Object.assign(new Error('anything'), { permanent: true }),
    ]) {
      expect(isPermanentAdapterStartError(permanent)).toBe(true);
    }
    for (const transient of [
      new Error('ECONNRESET'),
      new Error('getaddrinfo ENOTFOUND discord.com'),
      new Error('socket hang up'),
      new Error('502 Bad Gateway'),
    ]) {
      expect(isPermanentAdapterStartError(transient)).toBe(false);
    }
  });

  for (const file of ['gateway.ts', 'boot.ts']) {
    it(`${file} starts its adapters through startAdaptersIsolated`, () => {
      const src = readFileSync(join(import.meta.dirname, '..', 'commands', file), 'utf-8');
      expect(src).toContain('await startAdaptersIsolated(adapters,');
      // Retries are armed and stopped with the process (V-CC-4).
      expect(src).toContain('signal: adapterStartRetry.signal');
      expect(src).toContain('adapterStartRetry.abort()');
      expect(src).not.toContain('await Promise.all(adapters.map((a) => a.start()))');
    });
  }
});
