// The gateway lock + inbound spool setup shared by `ethos gateway start` and
// `ethos boot` (apps/ethos/src/lib/gateway-inbound-durability.ts; plan
// reach-and-containment §2.2–§2.7).
//
// `ethos boot` used to own platform adapters with neither: a boot beside a
// gateway polled the same bot tokens, and a crash under boot lost every message
// in flight. Two halves are pinned here:
//  - RUNTIME, the helpers themselves: a held lock is refused with exit 3, the
//    spool opens with the config's knobs, retention records its event, and the
//    boot replay reports and never throws.
//  - SOURCE TEXT, the ordering inside `runBoot` / `runGatewayStart`: both boot a
//    whole process and cannot be invoked from a unit test (`commands/boot.ts`
//    is not even runtime-importable under vitest — see
//    `boot-profile-command.test.ts`).

import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import { acquireGatewayLock, GATEWAY_LOCK_EXIT_CODE } from '@ethosagent/wiring';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INBOUND_SPOOL_DEAD_RETENTION_MS,
  INBOUND_SPOOL_RETENTION_MS,
  openInboundSpool,
  pruneInboundSpool,
  startInboundSpoolReplay,
  takeGatewayLockOrExit,
} from '../lib/gateway-inbound-durability';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const read = (rel: string) => readFile(join(ROOT, rel), 'utf8');

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ethos-gw-durability-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('takeGatewayLockOrExit', () => {
  it('refuses with exit 3 and the refusal text when a live process holds the lock', async () => {
    const dir = tempDir();
    const releaseHolder = await acquireGatewayLock(dir);
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit:${String(code)}`);
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(takeGatewayLockOrExit(dir)).rejects.toThrow(`exit:${GATEWAY_LOCK_EXIT_CODE}`);
    expect(GATEWAY_LOCK_EXIT_CODE).toBe(3);
    expect(exit).toHaveBeenCalledWith(3);
    expect(String(error.mock.calls[0]?.[0])).toContain('Another Ethos gateway is already running');

    releaseHolder();
  });

  it('takes a free lock, registers release on process exit, and frees it for the next holder', async () => {
    const dir = tempDir();
    const on = vi.spyOn(process, 'on').mockImplementation(() => process);

    const release = await takeGatewayLockOrExit(dir);
    expect(on).toHaveBeenCalledWith('exit', expect.any(Function));

    release();
    // Released: the next process (here, the next caller) gets it.
    const next = await acquireGatewayLock(dir);
    next();
  });
});

describe('openInboundSpool', () => {
  it('opens <dataDir>/inbound-spool.db with the gateway.inboundSpool knobs and a per-process owner', () => {
    const dir = tempDir();
    const config = {
      gateway: { inboundSpool: { maxAttempts: 5, maxReplayAgeMs: 60_000 } },
    } as unknown as EthosConfig;

    const { inboundSpool, inboundSpoolOptions } = openInboundSpool(config, dir);
    try {
      expect(inboundSpoolOptions.maxAttempts).toBe(5);
      expect(inboundSpoolOptions.maxReplayAgeMs).toBe(60_000);
      expect(inboundSpoolOptions.owner).toMatch(new RegExp(`^${process.pid}:`));
      expect(inboundSpool.stats()).toEqual({ received: 0, processing: 0, done: 0, dead: 0 });
    } finally {
      inboundSpool.close();
    }
  });

  it('leaves the knobs to the Gateway defaults when config sets none', () => {
    const { inboundSpool, inboundSpoolOptions } = openInboundSpool({} as EthosConfig, tempDir());
    inboundSpool.close();
    expect('maxAttempts' in inboundSpoolOptions).toBe(false);
    expect('maxReplayAgeMs' in inboundSpoolOptions).toBe(false);
  });
});

describe('pruneInboundSpool', () => {
  it('prunes done at 7 days and dead at 30, recording gateway.spool_dead_pruned', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const spool = { pruneDone: vi.fn(() => 2), pruneDead: vi.fn(() => 1) };
    const recordSafetyBlock = vi.fn();

    pruneInboundSpool(spool, { observability: { recordSafetyBlock }, warn: vi.fn() });

    expect(spool.pruneDone).toHaveBeenCalledWith(now - INBOUND_SPOOL_RETENTION_MS);
    expect(spool.pruneDead).toHaveBeenCalledWith(now - INBOUND_SPOOL_DEAD_RETENTION_MS);
    expect(recordSafetyBlock).toHaveBeenCalledWith({
      code: 'gateway.spool_dead_pruned',
      details: { count: 1 },
    });
  });

  it('a failing prune is a warning, never a throw', () => {
    const warn = vi.fn();
    const spool = {
      pruneDone: () => {
        throw new Error('database is locked');
      },
      pruneDead: () => 0,
    };
    expect(() =>
      pruneInboundSpool(spool, { observability: { recordSafetyBlock: vi.fn() }, warn }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('database is locked'));
  });
});

describe('startInboundSpoolReplay', () => {
  it('reports a replay that did work, and a failed replay as a warning', async () => {
    const info = vi.fn();
    const warn = vi.fn();
    startInboundSpoolReplay(
      { replayInboundSpool: async () => ({ replayed: 2, deferred: 1, dead: 0 }) },
      { info, warn },
    );
    startInboundSpoolReplay(
      { replayInboundSpool: async () => Promise.reject(new Error('no adapter')) },
      { info, warn },
    );
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(info).toHaveBeenCalledWith('Inbound spool: replayed 2, 1 deferred, 0 dead-lettered');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no adapter'));
  });
});

describe('both adapter-owning commands take the lock and the spool', () => {
  it('ethos boot: lock first, then stores; spool into the Gateway; replay after adapters start; close then release', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    const body = src.slice(src.indexOf('export async function runBoot('));
    const at = (needle: string) => {
      const i = body.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };

    const lock = at('await takeGatewayLockOrExit(dir)');
    // Before every store and every adapter.
    expect(lock).toBeLessThan(at('createSessionStore('));
    expect(lock).toBeLessThan(at('await createAgentLoop('));
    expect(lock).toBeLessThan(at('await buildGatewayAdapters('));
    expect(lock).toBeLessThan(at('new SQLiteDeliveryLedger('));

    const spool = at('openInboundSpool(cfg, dir)');
    expect(lock).toBeLessThan(spool);
    const build = body.slice(at('buildGateway({'));
    expect(build.slice(0, build.indexOf('\n  });'))).toMatch(
      /\n\s+inboundSpool,\n\s+inboundSpoolOptions,\n/,
    );

    const start = at('await Promise.all(adapters.map((a) => a.start()));');
    const replay = at('startInboundSpoolReplay(gateway,');
    expect(start).toBeLessThan(replay);
    expect(at('await runBootReconciliation(')).toBeLessThan(replay);
    expect(body).toMatch(/pruneSpool\(\);\n\s+const spoolPruneTimer = setInterval\(pruneSpool/);
    expect(body).toContain('clearInterval(spoolPruneTimer);');

    // Shutdown: the spool closes, then the lock is released — last of the
    // gateway-owned state.
    const close = at('inboundSpool.close();');
    expect(close).toBeLessThan(at('releaseGatewayLock();'));
  });

  it('ethos gateway start uses the same helpers', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    expect(src).toContain('await takeGatewayLockOrExit(ethosDir())');
    expect(src).toContain('openInboundSpool(config, ethosDir())');
    expect(src).toContain('startInboundSpoolReplay(gateway,');
    expect(src).toContain('pruneInboundSpool(inboundSpool,');
  });
});
