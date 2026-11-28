import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts', 'with-gate-lock.sh');
const dirs: string[] = [];
const children: ChildProcess[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-lock-'));
  dirs.push(dir);
  return dir;
}

function envFor(lockDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ETHOS_GATE_LOCK_DIR: lockDir,
    ETHOS_GATE_LOCK_POLL: '0.1',
    ...extra,
  };
  for (const k of ['CI', 'ETHOS_GATE_LOCK', 'ETHOS_GATE_LOCK_HELD']) delete env[k];
  return { ...env, ...extra };
}

function run(lockDir: string, args: string[], extra: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...args], { env: envFor(lockDir, extra), encoding: 'utf8' });
}

function spawnAsync(
  lockDir: string,
  args: string[],
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT, ...args], { env: envFor(lockDir) });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('with-gate-lock.sh', () => {
  it('serializes two concurrent runs', async () => {
    const dir = tmp();
    const lock = join(dir, 'lock');
    const log = join(dir, 'log');
    const body = `echo start >> ${log}; sleep 0.6; echo end >> ${log}`;
    const [a, b] = await Promise.all([
      spawnAsync(lock, ['sh', '-c', body]),
      spawnAsync(lock, ['sh', '-c', body]),
    ]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['start', 'end', 'start', 'end']);
    const waiter = [a, b].find((r) => r.stderr.includes('waiting'));
    expect(waiter?.stderr.match(/waiting/g)).toHaveLength(1);
  });

  it('passes the exit code through and releases the lock when the child fails', () => {
    const dir = tmp();
    const lock = join(dir, 'lock');
    expect(run(lock, ['sh', '-c', 'exit 7']).status).toBe(7);
    expect(existsSync(lock)).toBe(false);
    expect(run(lock, ['true']).status).toBe(0);
  });

  it('takes over a stale lock whose holder pid is dead', () => {
    const dir = tmp();
    const lock = join(dir, 'lock');
    const dead = spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim();
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), `${dead}\n`);
    writeFileSync(join(lock, 'cwd'), '/nowhere\n');
    const r = run(lock, ['echo', 'ran']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('ran\n');
    expect(existsSync(lock)).toBe(false);
  });

  it('bypasses with ETHOS_GATE_LOCK=0 even when the lock is held', () => {
    const dir = tmp();
    const lock = join(dir, 'lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
    const r = run(lock, ['echo', 'ran'], { ETHOS_GATE_LOCK: '0' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('ran\n');
    expect(existsSync(lock)).toBe(true);
  });

  it('does not deadlock on re-entrancy', () => {
    const dir = tmp();
    const lock = join(dir, 'lock');
    const r = run(lock, ['bash', SCRIPT, 'echo', 'inner']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('inner\n');
    expect(r.stderr).not.toContain('waiting');
  });
});
