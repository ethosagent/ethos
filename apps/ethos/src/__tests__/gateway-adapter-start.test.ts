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
import { startAdaptersIsolated } from '../commands/gateway';

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
    expect(result).toEqual({ started: [], failed: [] });
  });

  for (const file of ['gateway.ts', 'boot.ts']) {
    it(`${file} starts its adapters through startAdaptersIsolated`, () => {
      const src = readFileSync(join(import.meta.dirname, '..', 'commands', file), 'utf-8');
      expect(src).toContain('await startAdaptersIsolated(adapters,');
      expect(src).not.toContain('await Promise.all(adapters.map((a) => a.start()))');
    });
  }
});
