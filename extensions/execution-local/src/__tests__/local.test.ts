import { execFileSync } from 'node:child_process';
import type { ExecChunk, Logger, SecretsResolver } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { ExecAbortedError, ExecTimeoutError, LocalExecutionBackend } from '../index';

const secretsStub: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};

const loggerStub: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => loggerStub,
};

describe('LocalExecutionBackend', () => {
  it('streams interleaved stdout and stderr', async () => {
    const be = new LocalExecutionBackend({ config: {}, secrets: secretsStub, logger: loggerStub });
    const collected: ExecChunk[] = [];
    for await (const chunk of be.exec('echo out; echo err >&2', {})) {
      collected.push(chunk);
    }
    expect(collected.some((c) => c.stream === 'stdout')).toBe(true);
    expect(collected.some((c) => c.stream === 'stderr')).toBe(true);
  });

  it('emits a terminal exit chunk with code 0 on success', async () => {
    const be = new LocalExecutionBackend({ config: {}, secrets: secretsStub, logger: loggerStub });
    const collected: ExecChunk[] = [];
    for await (const chunk of be.exec('echo hi', {})) collected.push(chunk);
    const last = collected[collected.length - 1];
    expect(last?.stream).toBe('exit');
    expect(last && last.stream === 'exit' ? last.code : undefined).toBe(0);
  });

  it('emits the non-zero exit code from a failing command', async () => {
    const be = new LocalExecutionBackend({ config: {}, secrets: secretsStub, logger: loggerStub });
    const collected: ExecChunk[] = [];
    for await (const chunk of be.exec('exit 7', {})) collected.push(chunk);
    const exit = collected.find((c) => c.stream === 'exit');
    expect(exit && exit.stream === 'exit' ? exit.code : undefined).toBe(7);
  });
});

// UBP-007 / UBP-048 — the local backend kills the whole process group and does
// not hand the host's secrets to the command.
const posix = process.platform !== 'win32';

function uniqueSleep(): string {
  return `7.${Math.floor(Math.random() * 1e6)
    .toString()
    .padStart(6, '0')}`;
}

function survivors(pattern: string): string {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim();
  } catch {
    // pgrep exits 1 when nothing matches — the "no survivor" answer.
    return '';
  }
}

async function drain(it: AsyncIterable<ExecChunk>): Promise<ExecChunk[]> {
  const out: ExecChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!posix)('LocalExecutionBackend process lifetime', () => {
  const be = new LocalExecutionBackend({ config: {}, secrets: secretsStub, logger: loggerStub });

  it('a timeout kills grandchildren, not just bash', async () => {
    const s = uniqueSleep();
    const started = Date.now();
    await expect(drain(be.exec(`sleep ${s}; echo x`, { timeoutMs: 500 }))).rejects.toBeInstanceOf(
      ExecTimeoutError,
    );
    expect(Date.now() - started).toBeLessThan(1_500);
    await settle(300);
    expect(survivors(`sleep ${s}`)).toBe('');
  });

  it('an abort kills the process group', async () => {
    const s = uniqueSleep();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(
      drain(be.exec(`sleep ${s}; echo x`, { timeoutMs: 30_000, signal: ac.signal })),
    ).rejects.toBeInstanceOf(ExecAbortedError);
    await settle(300);
    expect(survivors(`sleep ${s}`)).toBe('');
  });

  it('a backgrounded child holding the pipe does not wedge the exec', async () => {
    const s = uniqueSleep();
    const started = Date.now();
    const chunks = await drain(be.exec(`sleep ${s} &`, { timeoutMs: 30_000 }));
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(chunks.at(-1)).toEqual({ stream: 'exit', code: 0 });
    await settle(300);
    expect(survivors(`sleep ${s}`)).toBe('');
  });
});

describe('LocalExecutionBackend env', () => {
  it('does not forward host secrets outside the passthrough allowlist', async () => {
    const be = new LocalExecutionBackend({ config: {}, secrets: secretsStub, logger: loggerStub });
    process.env.ETHOS_UBP048_LOCAL_API_KEY = 'sk-local-sentinel';
    try {
      const chunks = await drain(be.exec('env', { env: { EXPLICIT_VAR: 'yes' } }));
      const out = chunks.map((c) => (c.stream === 'exit' ? '' : c.data)).join('');
      expect(out).not.toContain('sk-local-sentinel');
      expect(out).toMatch(/^EXPLICIT_VAR=yes$/m);
      expect(out).toMatch(/^PATH=/m);
    } finally {
      delete process.env.ETHOS_UBP048_LOCAL_API_KEY;
    }
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

describe('LocalExecutionBackend env allowlist (V-ES-8)', () => {
  it('forwards operational vars and withholds secret-shaped and .env-loaded ones', async () => {
    const be = new LocalExecutionBackend({ config: {}, secrets: secretsStub, logger: loggerStub });
    const restore = stageEnv();
    try {
      const chunks = await drain(be.exec('env', {}));
      expectOperationalOnly(chunks.map((c) => (c.stream === 'exit' ? '' : c.data)).join(''));
    } finally {
      restore();
    }
  });
});
