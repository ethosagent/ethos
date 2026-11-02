import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const QUIET_SH = join(process.cwd(), 'scripts', 'lib', 'quiet.sh');
const dirs: string[] = [];

function run(body: string, env: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'quiet-'));
  dirs.push(cwd);
  const r = spawnSync('bash', ['-c', `source "${QUIET_SH}"; ${body}`], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { cwd, status: r.status, stdout: r.stdout };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('quiet_run', () => {
  it('prints the log path and keeps the exit code on failure', () => {
    const r = run('quiet_run t false');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('log: .logs/t.log');
    expect(existsSync(join(r.cwd, '.logs', 't.log'))).toBe(true);
  });

  it('prints nothing and exits 0 on success', () => {
    const r = run('quiet_run t true');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('shows failure-pattern lines from the log', () => {
    const r = run(`QUIET_FILTER='FAIL' quiet_run t bash -c 'echo noise; echo FAIL a.test; exit 3'`);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('FAIL a.test');
    expect(r.stdout).not.toContain('noise');
  });

  it('QUIET=0 streams output and writes no log', () => {
    const r = run(`quiet_run t bash -c 'echo streamed'`, { QUIET: '0' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('streamed');
    expect(existsSync(join(r.cwd, '.logs'))).toBe(false);
  });
});
