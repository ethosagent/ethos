import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentBootId } from '../backup/holder-identity';
import {
  acquireGatewayLock,
  GATEWAY_LOCK_EXIT_CODE,
  GatewayLockHeldError,
  gatewayLockPath,
  inspectGatewayLock,
} from '../gateway-lock';

/** A pid that is definitely not running, so a lock naming it is provably stale. */
function deadPid(): number {
  for (let p = 4_000_000; p > 100_000; p -= 7919) {
    try {
      process.kill(p, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return p;
    }
  }
  throw new Error('could not find a dead pid');
}

describe('acquireGatewayLock', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gateway-lock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lives at <dataDir>/gateway.lock and exits with code 3 on refusal', () => {
    expect(gatewayLockPath(dir)).toBe(join(dir, 'gateway.lock'));
    expect(GATEWAY_LOCK_EXIT_CODE).toBe(3);
  });

  it('a second acquire refuses at once, naming the holder pid', async () => {
    const release = await acquireGatewayLock(dir);
    const started = Date.now();
    const err = await acquireGatewayLock(dir).then(
      () => null,
      (e: unknown) => e,
    );
    // timeoutMs: 0 — one attempt, no waiting out a retry loop.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(err).toBeInstanceOf(GatewayLockHeldError);
    const held = err as GatewayLockHeldError;
    expect(held.holderPid).toBe(process.pid);
    expect(held.message).toContain(`Another Ethos gateway is already running for ${dir}`);
    expect(held.message).toContain(`pid ${process.pid}`);
    expect(held.message).toContain("'ethos gateway status'");
    expect(held.message).toContain(gatewayLockPath(dir));
    release();
    expect(existsSync(gatewayLockPath(dir))).toBe(false);
  });

  it('takes over a lock left by a dead pid', async () => {
    writeFileSync(
      gatewayLockPath(dir),
      JSON.stringify({ token: 'old', pid: deadPid(), boot: currentBootId() }),
    );
    expect(inspectGatewayLock(dir)).toMatchObject({ holder: 'stale' });
    const release = await acquireGatewayLock(dir);
    const body = JSON.parse(readFileSync(gatewayLockPath(dir), 'utf-8')) as { pid: number };
    expect(body.pid).toBe(process.pid);
    expect(inspectGatewayLock(dir)).toMatchObject({ holder: 'live', pid: process.pid });
    release();
  });

  it('release deletes only its own bytes', async () => {
    const release = await acquireGatewayLock(dir);
    // Another holder took it over (e.g. an operator removed ours and a new
    // gateway started): our release must not delete the successor's lock.
    const successor = JSON.stringify({ token: 'successor', pid: process.pid });
    writeFileSync(gatewayLockPath(dir), successor);
    release();
    expect(readFileSync(gatewayLockPath(dir), 'utf-8')).toBe(successor);
  });

  it('inspect reports none when no lock exists', () => {
    expect(inspectGatewayLock(dir)).toEqual({ holder: 'none' });
  });
});
