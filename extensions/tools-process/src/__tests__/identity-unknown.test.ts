// V3-4 — a failed or timed-out start-time read (`/bin/ps` on macOS,
// `/proc/<pid>/stat` on Linux) returned null, and `matchesIdentity` read null
// as 'different'. Since V2-SEC-5 that answer drives liveness, so ONE transient
// ps failure (its timeout under load, EAGAIN/EMFILE, a sandbox with no
// /bin/ps) orphaned a LIVE process for good: it left the registry's tracking,
// freed its PROCESS_CAP slot, and process_stop refused to signal it. A read
// that cannot answer is now 'unknown' (../process-identity.ts): the entry
// stays running and keeps its slot, and process_stop signals the pid alone.
// Only "ps exited 1 with no output" / "/proc/<pid> is missing" mean gone.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Mode = 'real' | 'spawn-error' | 'timeout' | 'gone';
const ps = vi.hoisted(() => ({ mode: 'real' as Mode, calls: 0 }));
type ProcMode = 'real' | 'eacces' | 'enoent';
const proc = vi.hoisted(() => ({ mode: 'real' as ProcMode }));

function psError(mode: Mode): Error {
  if (mode === 'timeout') {
    // The shape execFile gives a child it killed at its `timeout`.
    return Object.assign(new Error('Command failed: /bin/ps'), {
      killed: true,
      signal: 'SIGTERM',
      code: null,
    });
  }
  if (mode === 'gone') {
    return Object.assign(new Error('Command failed: /bin/ps'), { code: 1, killed: false });
  }
  return Object.assign(new Error('spawn /bin/ps EAGAIN'), { code: 'EAGAIN', errno: -35 });
}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const faked = (file: unknown): boolean => file === '/bin/ps' && ps.mode !== 'real';
  return {
    ...real,
    execFileSync: (...args: Parameters<typeof real.execFileSync>) => {
      if (args[0] === '/bin/ps') ps.calls++;
      if (faked(args[0])) throw psError(ps.mode);
      return real.execFileSync(...args);
    },
    execFile: (...args: unknown[]) => {
      if (args[0] === '/bin/ps') ps.calls++;
      if (faked(args[0])) {
        const cb = args[args.length - 1] as (e: Error, out: string, err: string) => void;
        const err = psError(ps.mode);
        setImmediate(() => cb(err, '', ''));
        return undefined;
      }
      return (real.execFile as (...a: unknown[]) => unknown)(...args);
    },
  };
});

function procError(mode: ProcMode): Error {
  return mode === 'eacces'
    ? Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    : Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
}
const isProcStat = (p: unknown): boolean =>
  typeof p === 'string' && /^\/proc\/\d+\/stat$/.test(p) && proc.mode !== 'real';

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    readFileSync: (...args: Parameters<typeof real.readFileSync>) => {
      if (isProcStat(args[0])) throw procError(proc.mode);
      return real.readFileSync(...args);
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    readFile: (...args: Parameters<typeof real.readFile>) => {
      if (isProcStat(args[0])) return Promise.reject(procError(proc.mode));
      return real.readFile(...args);
    },
  };
});

const { createProcessTools } = await import('../index');
const { listProcesses, reconcileRegistry, stopProcess } = await import('../operations');
const { matchesIdentity, processStartToken } = await import('../process-identity');
const { loadRegistry, saveRegistry } = await import('../registry');
const { spawnDetached } = await import('../spawn');
type ProcessEntry = import('../registry').ProcessEntry;

const realPlatform = process.platform;
function forcePlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

let dataDir: string;
const children: ChildProcess[] = [];
const groups: number[] = [];

function liveSleep(): number {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  children.push(child);
  if (child.pid === undefined) throw new Error('spawn failed');
  return child.pid;
}

function entry(id: string, pid: number, patch: Partial<ProcessEntry> = {}): ProcessEntry {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    pid,
    command: 'sleep 30',
    cwd: dataDir,
    status: 'running',
    startedAt: now,
    lastTouchedAt: now,
    started_by: 'tester',
    ...patch,
  };
}

function ctx() {
  return {
    sessionId: 's',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: dataDir,
    personalityId: 'tester',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  };
}

function tool(name: string, capMax?: number): Tool {
  const t = createProcessTools(dataDir, capMax ? { capMax } : undefined).find(
    (x) => x.name === name,
  );
  if (!t) throw new Error(name);
  return t;
}

beforeEach(() => {
  dataDir = join(tmpdir(), `ethos-id-unknown-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dataDir, { recursive: true });
  ps.mode = 'real';
  ps.calls = 0;
  proc.mode = 'real';
});

afterEach(() => {
  forcePlatform(realPlatform);
  ps.mode = 'real';
  proc.mode = 'real';
  for (const c of children.splice(0)) c.kill('SIGKILL');
  for (const pid of groups.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe.skipIf(realPlatform === 'win32')('a start-time read that cannot answer (V3-4)', () => {
  // Forcing `darwin` routes the read through the mocked /bin/ps on every host.
  describe('macOS: /bin/ps fails or times out', () => {
    beforeEach(() => forcePlatform('darwin'));

    it('a ps spawn failure is unknown, not different', async () => {
      const pid = liveSleep();
      ps.mode = 'spawn-error';
      expect(
        await matchesIdentity(pid, { pidStartToken: 'darwin-utc:Mon Jan 1 00:00:00 2001' }),
      ).toBe('unknown');
    });

    it('a ps timeout is unknown, not different', async () => {
      const pid = liveSleep();
      ps.mode = 'timeout';
      expect(
        await matchesIdentity(pid, { pidStartToken: 'darwin-utc:Mon Jan 1 00:00:00 2001' }),
      ).toBe('unknown');
      // A legacy token takes the same road.
      expect(await matchesIdentity(pid, { pidStartToken: 'darwin:Mon Jan 1 00:00:00 2001' })).toBe(
        'unknown',
      );
    });

    it('ps saying "no such pid" (exit 1, no output) is still different', async () => {
      const pid = liveSleep();
      ps.mode = 'gone';
      expect(
        await matchesIdentity(pid, { pidStartToken: 'darwin-utc:Mon Jan 1 00:00:00 2001' }),
      ).toBe('different');
    });

    it('reconcile and process_list keep a live entry running while ps fails', async () => {
      const pid = liveSleep();
      saveRegistry(dataDir, { live: entry('live', pid, { pidStartToken: 'darwin-utc:any' }) });
      ps.mode = 'timeout';
      await reconcileRegistry(dataDir);
      expect(loadRegistry(dataDir).live?.status).toBe('running');
      ps.mode = 'spawn-error';
      const items = await listProcesses(dataDir);
      expect(items.map((i) => [i.id, i.status])).toEqual([['live', 'running']]);
    });

    it('a live entry keeps its PROCESS_CAP slot while ps fails', async () => {
      const pid = liveSleep();
      saveRegistry(dataDir, { live: entry('live', pid, { pidStartToken: 'darwin-utc:any' }) });
      ps.mode = 'spawn-error';
      const result = await tool('process_start', 1).execute({ command: 'sleep 0.1' }, ctx());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/PROCESS_CAP_EXCEEDED/);
      expect(loadRegistry(dataDir).live?.status).toBe('running');
    });

    it('process_wait does not report a live process as exited while ps fails', async () => {
      const pid = liveSleep();
      saveRegistry(dataDir, { live: entry('live', pid, { pidStartToken: 'darwin-utc:any' }) });
      ps.mode = 'timeout';
      const result = await tool('process_wait').execute({ id: 'live', timeout_s: 1 }, ctx());
      expect(result.ok && JSON.parse(result.value).exited).toBe(false);
      expect(loadRegistry(dataDir).live?.status).toBe('running');
    });

    it('process_stop signals the pid alone (never the group) when identity is unknown', async () => {
      forcePlatform(realPlatform);
      const s = `7.${Math.floor(Math.random() * 1e6)
        .toString()
        .padStart(6, '0')}`;
      const { pid } = await spawnDetached(
        'grp',
        `sleep ${s} & sleep ${s}; wait`,
        dataDir,
        undefined,
        dataDir,
      );
      groups.push(pid);
      await new Promise((r) => setTimeout(r, 200));
      forcePlatform('darwin');
      saveRegistry(dataDir, { grp: entry('grp', pid, { pidStartToken: 'darwin-utc:any' }) });
      ps.mode = 'timeout';
      const result = await stopProcess(dataDir, 'grp', 'SIGKILL');
      expect(result).toMatchObject({ ok: true, stopped: true });
      await new Promise((r) => setTimeout(r, 200));
      forcePlatform(realPlatform);
      // The leader is gone; its background child was not signalled.
      expect(() => process.kill(pid, 0)).toThrow();
      let alive = '';
      try {
        alive = execFileSync('pgrep', ['-f', `sleep ${s}`], { encoding: 'utf8' }).trim();
      } catch {
        alive = '';
      }
      expect(alive).not.toBe('');
    });
  });

  describe('Linux: /proc/<pid>/stat cannot be read', () => {
    beforeEach(() => forcePlatform('linux'));

    it('EACCES is unknown, and the entry stays running', async () => {
      const pid = liveSleep();
      proc.mode = 'eacces';
      expect(await matchesIdentity(pid, { pidStartToken: 'linux:1' })).toBe('unknown');
      saveRegistry(dataDir, { live: entry('live', pid, { pidStartToken: 'linux:1' }) });
      await reconcileRegistry(dataDir);
      expect(loadRegistry(dataDir).live?.status).toBe('running');
    });

    it('ENOENT (no /proc/<pid>) is different', async () => {
      const pid = liveSleep();
      proc.mode = 'enoent';
      expect(await matchesIdentity(pid, { pidStartToken: 'linux:1' })).toBe('different');
    });
  });

  describe.skipIf(realPlatform !== 'darwin' && realPlatform !== 'linux')(
    'a read that answers is still decisive',
    () => {
      it('identity match: the recorded token is the same process', async () => {
        const pid = liveSleep();
        const token = await processStartToken(pid);
        expect(token).toMatch(/\S/);
        expect(await matchesIdentity(pid, { pidStartToken: token ?? '' })).toBe('same');
      });

      it('identity mismatch: a reused pid is different, and is orphaned', async () => {
        const pid = liveSleep();
        expect(await matchesIdentity(pid, { pidStartToken: 'recorded-for-another' })).toBe(
          'different',
        );
        saveRegistry(dataDir, { stale: entry('stale', pid, { pidStartToken: 'other' }) });
        await reconcileRegistry(dataDir);
        expect(loadRegistry(dataDir).stale?.status).toBe('orphan');
      });

      it('repeated liveness polls of a verified entry do not re-run ps every time', async () => {
        const pid = liveSleep();
        const token = await processStartToken(pid);
        saveRegistry(dataDir, { live: entry('live', pid, { pidStartToken: token ?? '' }) });
        ps.calls = 0;
        for (let i = 0; i < 5; i++) await listProcesses(dataDir);
        if (realPlatform === 'darwin') expect(ps.calls).toBeLessThanOrEqual(1);
        expect(loadRegistry(dataDir).live?.status).toBe('running');
      });
    },
  );
});
