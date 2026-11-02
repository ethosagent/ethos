import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO = process.cwd();
const NOOP = { status: 0, stdout: '' };
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
const expectAllow = (script: string, payload: unknown) =>
  expect(run(script, payload)).toEqual(NOOP);
const bash = (command: string) => ({ tool_name: 'Bash', cwd: dir, tool_input: { command } });

describe('read-size-guard', () => {
  const big = () => join(dir, 'big.ts');
  beforeEach(() => writeFileSync(big(), 'x\n'.repeat(401)));

  it('denies a 401-line file with no range', () => {
    const r = run('read-size-guard.sh', read(big()));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('401 lines');
  });
  it('allows the same file with a limit', () => {
    expectAllow('read-size-guard.sh', read(big(), { limit: 50 }));
  });
  it('allows a missing path', () => {
    expectAllow('read-size-guard.sh', read(join(dir, 'nope.ts')));
  });
  it('allows an image extension', () => {
    const f = join(dir, 'x.png');
    writeFileSync(f, 'x\n'.repeat(401));
    expectAllow('read-size-guard.sh', read(f));
  });
  it('allows a path outside the repo', () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    try {
      const f = join(outside, 'big.ts');
      writeFileSync(f, 'x\n'.repeat(401));
      expectAllow('read-size-guard.sh', read(f));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it('allows a binary file with a NUL after the first 8 KiB', () => {
    const f = join(dir, 'bin.dat');
    writeFileSync(
      f,
      Buffer.concat([
        Buffer.from('a'.repeat(9 * 1024)),
        Buffer.from('\n'.repeat(401)),
        Buffer.from([0]),
      ]),
    );
    expectAllow('read-size-guard.sh', read(f));
  });
  it('allows a file whose NUL appears only after the first 64 KiB chunk had over 400 lines', () => {
    const f = join(dir, 'late-nul.dat');
    writeFileSync(
      f,
      Buffer.concat([
        Buffer.from('\n'.repeat(401)),
        Buffer.from('a'.repeat(70 * 1024)),
        Buffer.from([0]),
      ]),
    );
    expectAllow('read-size-guard.sh', read(f));
  });
  it('allows a 400-line file', () => {
    const f = join(dir, 'ok.ts');
    writeFileSync(f, 'x\n'.repeat(400));
    expectAllow('read-size-guard.sh', read(f));
  });
});

describe('quiet-checks', () => {
  it('denies pnpm test', () => {
    const out = JSON.parse(run('quiet-checks.sh', bash('pnpm test')).stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('denies pnpm check after a cd', () => {
    const out = JSON.parse(run('quiet-checks.sh', bash('cd x && pnpm check')).stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('denies pnpm test inside a compound command', () => {
    const out = JSON.parse(run('quiet-checks.sh', bash('pnpm test && pnpm lint')).stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it.each([
    'pnpm run test',
    'pnpm  test',
    'pnpm -w test',
    'pnpm --workspace-root test',
    'pnpm -w check',
    'pnpm run check',
    'pnpm\rtest',
    'pnpm\ftest',
  ])('denies %j', (cmd) => {
    const out = JSON.parse(run('quiet-checks.sh', bash(cmd)).stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it.each([
    'pnpm test extensions/gateway',
    'pnpm test:integration',
    'pnpm run test:integration',
    'pnpm typecheck',
    'bash scripts/check-tests.sh',
  ])('allows %s', (cmd) => {
    expectAllow('quiet-checks.sh', bash(cmd));
  });
});

describe('session-compact', () => {
  const plan = (rel: string, mtimeSec: number) => {
    const f = join(dir, 'plan', rel);
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, '# p\n');
    utimesSync(f, mtimeSec, mtimeSec);
  };

  it('prints nothing without plan/', () => {
    expectAllow('session-compact.sh', { cwd: dir });
  });
  it('prints the active plan', () => {
    plan('a.md', 1000);
    expect(run('session-compact.sh', { cwd: dir })).toEqual({
      status: 0,
      stdout: 'Active plan: plan/a.md\n',
    });
  });
  it('picks a newer plan/phases file over an older plan file', () => {
    plan('a.md', 1000);
    plan('phases/x.md', 2000);
    expect(run('session-compact.sh', { cwd: dir }).stdout).toBe('Active plan: plan/phases/x.md\n');
  });
});
