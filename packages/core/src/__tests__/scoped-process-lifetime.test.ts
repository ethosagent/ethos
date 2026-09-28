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

// V-ES-8 — the allowlist must keep ordinary commands working (git over ssh,
// a corporate proxy, locale, toolchain roots) and still never pass a name
// that looks like a secret or one loaded from ~/.ethos/.env.
const OPERATIONAL_ENV: Record<string, string> = {
  SSH_AUTH_SOCK: '/tmp/ves8-agent.sock',
  HTTPS_PROXY: 'http://proxy.ves8:3128',
  https_proxy: 'http://proxy.ves8:3128',
  NO_PROXY: 'localhost,.ves8',
  LC_CTYPE: 'UTF-8',
  GOPATH: '/tmp/ves8-go',
  NVM_DIR: '/tmp/ves8-nvm',
  XDG_CONFIG_HOME: '/tmp/ves8-xdg',
  TERM_PROGRAM: 'ves8-term',
  COLORTERM: 'truecolor',
  VIRTUAL_ENV: '/tmp/ves8-venv',
  JAVA_HOME: '/tmp/ves8-jdk',
};
const SECRET_ENV: Record<string, string> = {
  VES8_API_KEY: 'ves8-secret-1',
  GITHUB_TOKEN: 'ves8-secret-2',
  AWS_REGION: 'ves8-secret-3',
  NVM_AUTH_TOKEN: 'ves8-secret-4',
  CONDA_PASSWORD: 'ves8-secret-5',
  XDG_SECRET_KEY: 'ves8-secret-6',
  ALL_PROXY: 'ves8-secret-7',
  // V2-SEC-6: a credential inside an allowed family's VALUE, and the
  // *_PWD / *_PASS spellings the name filter used to miss.
  NVM_NODEJS_ORG_MIRROR: 'https://bob:ves8-secret-8@mirror.ves8/node',
  CONDA_CHANNEL_ALIAS: 'https://tok:ves8-secret-9@conda.ves8',
  CONDA_PWD: 'ves8-secret-10',
  XDG_DB_PASS: 'ves8-secret-11',
  LC_VES8_HINT: 'ghp_ves8secret12ves8secret12ves8secret12xx',
};

/** Sets the fixture vars (ALL_PROXY marked as loaded from ~/.ethos/.env) and returns a restore. */
function stageEnv(): () => void {
  const saved = new Map<string, string | undefined>();
  const all = { ...OPERATIONAL_ENV, ...SECRET_ENV, ETHOS_DOTENV_KEYS: 'ALL_PROXY' };
  for (const [k, v] of Object.entries(all)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function expectOperationalOnly(out: string): void {
  for (const [k, v] of Object.entries(OPERATIONAL_ENV)) expect(out).toContain(`${k}=${v}\n`);
  for (const v of Object.values(SECRET_ENV)) expect(out).not.toContain(v);
}

describe('ScopedProcessImpl env allowlist (V-ES-8)', () => {
  const proc = new ScopedProcessImpl(new Set(['*']));

  it('forwards operational vars and withholds secret-shaped and .env-loaded ones', async () => {
    const restore = stageEnv();
    try {
      const result = await proc.spawn('env', []);
      expectOperationalOnly(result.stdout);
    } finally {
      restore();
    }
  });
});
