// Pins sessions-repair/holders.ts (plan session-db-repair 6.2). Each case uses its
// own temp data dir because the 30 s cache is keyed by dataDir.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeSessionsDbHolders, type ExecFn, parseLsofFields } from '../holders';

const dirs: string[] = [];
function dataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'holders-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const noLsof: ExecFn = async () => {
  throw Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' });
};

/** Real `lsof -F pcn` output (macOS lsof 4.91): p/c per process, then f/n per file. */
const LSOF =
  'p4242\ncethos\nf11\nnsessions.db\nf12\nnsessions.db-wal\np5150\ncnode\nf9\nnsessions.db\n';

describe('describeSessionsDbHolders', () => {
  it('a live gateway.lock names its pid and start time', async () => {
    const dir = dataDir();
    writeFileSync(
      join(dir, 'gateway.lock'),
      JSON.stringify({ pid: process.pid, startedAt: '2026-10-18T09:14:30.000Z' }),
    );
    const out = await describeSessionsDbHolders(dir, { exec: noLsof });
    expect(out).toEqual([`ethos gateway (pid ${process.pid}, started 09:14 UTC)`]);
  });

  it('a stale lock is not named as a holder', async () => {
    const dir = dataDir();
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(join(dir, 'gateway.lock'), JSON.stringify({ pid: dead, startedAt: 'x' }));
    expect(await describeSessionsDbHolders(dir, { exec: noLsof })).toEqual([]);
  });

  it('a fresh heartbeat with a live pid names the gateway; a stale one does not', async () => {
    const fresh = dataDir();
    const now = Date.parse('2026-10-18T10:00:00.000Z');
    writeFileSync(
      join(fresh, 'gateway-health.json'),
      JSON.stringify({
        pid: 777,
        startedAt: '2026-10-18T08:00:00.000Z',
        updatedAt: '2026-10-18T09:59:50.000Z',
      }),
    );
    expect(
      await describeSessionsDbHolders(fresh, { exec: noLsof, now: () => now, isAlive: () => true }),
    ).toEqual(['ethos gateway (pid 777, started 08:00 UTC)']);

    const old = dataDir();
    writeFileSync(
      join(old, 'gateway-health.json'),
      JSON.stringify({ pid: 777, startedAt: 'x', updatedAt: '2026-10-18T09:00:00.000Z' }),
    );
    expect(
      await describeSessionsDbHolders(old, { exec: noLsof, now: () => now, isAlive: () => true }),
    ).toEqual([]);
  });

  it('lsof output is parsed and our own pid is dropped', async () => {
    const dir = dataDir();
    const exec = vi.fn<ExecFn>(async () => ({ stdout: `p${process.pid}\ncself\n${LSOF}` }));
    const out = await describeSessionsDbHolders(dir, { exec });
    expect(out).toEqual(['processes with sessions.db open: ethos (pid 4242), node (pid 5150)']);
    const [file, args, opts] = exec.mock.calls[0] ?? [];
    expect(file).toBe('lsof');
    expect(args).toEqual([
      '-nP',
      '-F',
      'pcn',
      '--',
      'sessions.db',
      'sessions.db-wal',
      'sessions.db-shm',
    ]);
    expect(opts).toMatchObject({ timeout: 1500, cwd: dir });
  });

  it('partial stdout from a non-zero lsof exit (an absent -wal) is still parsed', async () => {
    const exec: ExecFn = async () => {
      throw Object.assign(new Error('exit 1'), { stdout: LSOF });
    };
    const out = await describeSessionsDbHolders(dataDir(), { exec });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('pid 4242');
  });

  it('lsof missing falls back to an empty list (the caller supplies generic text)', async () => {
    expect(await describeSessionsDbHolders(dataDir(), { exec: noLsof })).toEqual([]);
  });

  it('an lsof timeout returns an empty list', async () => {
    const exec: ExecFn = async () => {
      throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
    };
    expect(await describeSessionsDbHolders(dataDir(), { exec })).toEqual([]);
  });

  it('the result is cached for 30 s and concurrent calls share one probe', async () => {
    const dir = dataDir();
    let t = 1_000_000;
    let release: (v: { stdout: string }) => void = () => undefined;
    const exec = vi.fn<ExecFn>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const deps = { exec, now: () => t };
    const a = describeSessionsDbHolders(dir, deps);
    const b = describeSessionsDbHolders(dir, deps);
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
    release({ stdout: LSOF });
    expect(await a).toEqual(await b);
    expect(exec).toHaveBeenCalledTimes(1);

    t += 29_000;
    await describeSessionsDbHolders(dir, deps);
    expect(exec).toHaveBeenCalledTimes(1);

    t += 2_000; // past 30 s
    const again = describeSessionsDbHolders(dir, deps);
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(2));
    release({ stdout: '' });
    expect(await again).toEqual([]);
  });
});

describe('parseLsofFields', () => {
  it('reads p and c lines and ignores f and n', () => {
    expect(parseLsofFields(LSOF)).toEqual([
      { pid: 4242, command: 'ethos' },
      { pid: 5150, command: 'node' },
    ]);
    expect(parseLsofFields('')).toEqual([]);
    expect(parseLsofFields('pnotanumber\ncx\n')).toEqual([]);
  });
});
