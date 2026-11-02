import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO = process.cwd();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(script: string, payload: unknown): { status: number; stdout: string } {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
  try {
    const stdout = execFileSync('bash', [join(REPO, 'scripts/hooks', script)], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      cwd: dir,
      env,
    });
    return { status: 0, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '' };
  }
}

const read = (file_path: string, extra: object = {}) => ({
  tool_name: 'Read',
  cwd: dir,
  tool_input: { file_path, ...extra },
});
const bash = (command: string) => ({ tool_name: 'Bash', cwd: dir, tool_input: { command } });

describe('read-size-guard', () => {
  it('denies a 401-line file with no range', () => {
    const f = join(dir, 'big.ts');
    writeFileSync(f, 'x\n'.repeat(401));
    const r = run('read-size-guard.sh', read(f));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('401 lines');
  });
  it('allows the same file with a limit', () => {
    const f = join(dir, 'big.ts');
    writeFileSync(f, 'x\n'.repeat(401));
    expect(run('read-size-guard.sh', read(f, { limit: 50 }))).toEqual({ status: 0, stdout: '' });
  });
  it('allows a missing path', () => {
    expect(run('read-size-guard.sh', read(join(dir, 'nope.ts')))).toEqual({
      status: 0,
      stdout: '',
    });
  });
  it('allows an image extension', () => {
    const f = join(dir, 'x.png');
    writeFileSync(f, 'x\n'.repeat(401));
    expect(run('read-size-guard.sh', read(f))).toEqual({ status: 0, stdout: '' });
  });
  it('allows a path outside the repo', () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    try {
      const f = join(outside, 'big.ts');
      writeFileSync(f, 'x\n'.repeat(401));
      expect(run('read-size-guard.sh', read(f))).toEqual({ status: 0, stdout: '' });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('quiet-checks', () => {
  it('denies pnpm test', () => {
    const out = JSON.parse(run('quiet-checks.sh', bash('pnpm test')).stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('denies pnpm test inside a compound command', () => {
    const out = JSON.parse(run('quiet-checks.sh', bash('pnpm test && pnpm lint')).stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it.each(['pnpm test extensions/gateway', 'pnpm test:integration', 'bash scripts/check-tests.sh'])(
    'allows %s',
    (cmd) => {
      expect(run('quiet-checks.sh', bash(cmd))).toEqual({ status: 0, stdout: '' });
    },
  );
});

describe('session-compact', () => {
  it('prints nothing without plan/', () => {
    expect(run('session-compact.sh', { cwd: dir })).toEqual({ status: 0, stdout: '' });
  });
  it('prints the active plan', () => {
    mkdirSync(join(dir, 'plan'));
    writeFileSync(join(dir, 'plan', 'a.md'), '# a\n');
    expect(run('session-compact.sh', { cwd: dir })).toEqual({
      status: 0,
      stdout: 'Active plan: plan/a.md\n',
    });
  });
});
