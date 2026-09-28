import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { ScopedProcessImpl } from '../scoped/scoped-process';

// UBP-007 / UBP-042 / UBP-048 — the host process lifetime and env contract of
// ScopedProcessImpl. POSIX-only: the process-group kill is what is under test.
const posix = process.platform !== 'win32';

/** A sleep duration no other process on the machine is using, so pgrep -f finds only ours. */
function uniqueSleep(): string {
  return `7.${Math.floor(Math.random() * 1e6)
    .toString()
    .padStart(6, '0')}`;
}

function survivors(pattern: string): string {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim();
  } catch {
    // pgrep exits 1 when nothing matches — that is the "no survivor" answer.
    return '';
  }
}

async function settle(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe.skipIf(!posix)('ScopedProcessImpl process lifetime (UBP-007)', () => {
  const proc = new ScopedProcessImpl(new Set(['*']));

  it('honours the timeout when a foreground grandchild holds stdout', async () => {
    const s = uniqueSleep();
    const started = Date.now();
    const result = await proc.spawn('bash', ['-c', `sleep ${s}; echo x`], { timeout: 500 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1_500);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('x');
    expect(result.stderr).toContain('timed out after 500ms');
    await settle(200);
    expect(survivors(`sleep ${s}`)).toBe('');
  });

  it('does not wait for a backgrounded child that keeps the pipe open', async () => {
    const s = uniqueSleep();
    const started = Date.now();
    await proc.spawn('bash', ['-c', `sleep ${s} &`], { timeout: 500 });
    expect(Date.now() - started).toBeLessThan(1_500);
    await settle(200);
    expect(survivors(`sleep ${s}`)).toBe('');
  });

  it('keeps output from a command that finishes normally', async () => {
    const result = await proc.spawn('bash', ['-c', 'echo one; echo two >&2; exit 3'], {
      timeout: 5_000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stdout.trim()).toBe('one');
    expect(result.stderr.trim()).toBe('two');
  });
});

describe.skipIf(!posix)('ScopedProcessImpl abort (UBP-042)', () => {
  const proc = new ScopedProcessImpl(new Set(['*']));

  it('kills the process group and rejects promptly when the signal aborts', async () => {
    const s = uniqueSleep();
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 100);
    await expect(
      proc.spawn('bash', ['-c', `sleep ${s}; echo x`], { timeout: 30_000, signal: ac.signal }),
    ).rejects.toThrow(/ABORTED/);
    expect(Date.now() - started).toBeLessThan(1_000);
    await settle(200);
    expect(survivors(`sleep ${s}`)).toBe('');
  });

  it('refuses to start when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(proc.spawn('echo', ['hi'], { signal: ac.signal })).rejects.toThrow(/ABORTED/);
  });
});

describe('ScopedProcessImpl env (UBP-048)', () => {
  const proc = new ScopedProcessImpl(new Set(['*']));
  const KEY = 'ETHOS_UBP048_SENTINEL_API_KEY';

  afterEach(() => {
    delete process.env[KEY];
  });

  it('does not forward host secrets outside the passthrough allowlist', async () => {
    process.env[KEY] = 'sk-sentinel-value';
    const result = await proc.spawn('env', []);
    expect(result.stdout).not.toContain('sk-sentinel-value');
    expect(result.stdout).toMatch(/^PATH=/m);
  });

  it('layers explicit env on top of the allowlist', async () => {
    const result = await proc.spawn('env', [], { env: { EXPLICIT_VAR: 'yes' } });
    expect(result.stdout).toMatch(/^EXPLICIT_VAR=yes$/m);
  });

  it('forwards the full env only when the caller opts in', async () => {
    process.env[KEY] = 'sk-sentinel-value';
    const result = await proc.spawn('env', [], { inheritEnv: true });
    expect(result.stdout).toContain('sk-sentinel-value');
  });
});
