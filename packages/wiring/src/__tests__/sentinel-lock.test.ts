// The shared advisory `wx` sentinel behind `acquireBackupLock` and
// `acquireIdentityMapLock`. Those two keep their own end-to-end tests; these pin
// the helper's protocol directly, with each caller-owned knob passed explicitly.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentBootId } from '../backup/holder-identity';
import { acquireSentinelLock, type SentinelLockOptions } from '../backup/sentinel-lock';

let root: string;
let lockPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ethos-sentinel-lock-'));
  lockPath = join(root, 'nested', 'dir', 'thing.lock');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

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

function plant(body: string): void {
  mkdirSync(join(root, 'nested', 'dir'), { recursive: true });
  writeFileSync(lockPath, body);
}

const liveBody = () => JSON.stringify({ token: 'live', pid: process.pid, boot: currentBootId() });

function options(over: Partial<SentinelLockOptions> = {}): SentinelLockOptions {
  return {
    lockPath,
    timeoutMs: 0,
    retryMs: 10,
    unreadableStaleMs: 1_000,
    refusal: (pid) => `refused: held by ${pid === null ? 'nobody readable' : pid}`,
    ...over,
  };
}

describe('acquireSentinelLock', () => {
  it('creates the parent directory and an owned body, and release removes it', async () => {
    const release = await acquireSentinelLock(options());
    const body: unknown = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(body).toMatchObject({ pid: process.pid, boot: currentBootId() });
    expect(typeof (body as { token: unknown }).token).toBe('string');
    expect(typeof (body as { startedAt: unknown }).startedAt).toBe('string');
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses at once with timeoutMs 0 when a live holder owns it, naming the pid', async () => {
    const body = liveBody();
    plant(body);
    const started = Date.now();
    await expect(acquireSentinelLock(options({ retryMs: 5_000 }))).rejects.toThrow(
      `refused: held by ${process.pid}`,
    );
    // No sleep happened: one attempt, then the refusal.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(readFileSync(lockPath, 'utf-8')).toBe(body);
  });

  it('waits while contended, then acquires once the holder releases', async () => {
    plant(liveBody());
    let settled = false;
    const acquiring = acquireSentinelLock(options({ timeoutMs: 5_000 })).finally(() => {
      settled = true;
    });
    await new Promise<void>((r) => setTimeout(r, 100));
    expect(settled).toBe(false);

    unlinkSync(lockPath);
    const release = await acquiring;
    expect(readFileSync(lockPath, 'utf-8')).toContain(`"pid":${process.pid}`);
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('takes over a lock whose pid is gone', async () => {
    plant(JSON.stringify({ token: 'abandoned', pid: deadPid(), boot: currentBootId() }));
    const release = await acquireSentinelLock(options());
    expect(readFileSync(lockPath, 'utf-8')).not.toContain('abandoned');
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('never takes over a live pid, however old the lock is', async () => {
    const body = liveBody();
    plant(body);
    const longAgo = new Date(Date.now() - 37 * 60 * 60 * 1000);
    utimesSync(lockPath, longAgo, longAgo);
    await expect(acquireSentinelLock(options({ unreadableStaleMs: 1 }))).rejects.toThrow(/refused/);
    expect(readFileSync(lockPath, 'utf-8')).toBe(body);
  });

  it('judges a body with no readable pid by unreadableStaleMs, and names no pid', async () => {
    plant('garbage, not json');
    await expect(acquireSentinelLock(options({ unreadableStaleMs: 60_000 }))).rejects.toThrow(
      'refused: held by nobody readable',
    );
    expect(readFileSync(lockPath, 'utf-8')).toBe('garbage, not json');

    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);
    const release = await acquireSentinelLock(options({ unreadableStaleMs: 60_000 }));
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('does not unlink a stale lock that was replaced after it was read', async () => {
    plant(JSON.stringify({ token: 'abandoned', pid: deadPid() }));
    const successor = JSON.stringify({ token: 'successor', pid: process.pid });

    // A peer takes the abandoned lock over while we are classifying it.
    let firstProbe = true;
    const probe = vi.spyOn(process, 'kill').mockImplementation((): true => {
      if (!firstProbe) return true;
      firstProbe = false;
      writeFileSync(lockPath, successor);
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    try {
      await expect(acquireSentinelLock(options())).rejects.toThrow(/refused/);
      expect(readFileSync(lockPath, 'utf-8')).toBe(successor);
    } finally {
      probe.mockRestore();
    }
  });

  it('release deletes only its own bytes', async () => {
    const release = await acquireSentinelLock(options());
    const successor = JSON.stringify({ token: 'successor', pid: process.pid });
    writeFileSync(lockPath, successor);

    release();

    expect(readFileSync(lockPath, 'utf-8')).toBe(successor);
  });
});
