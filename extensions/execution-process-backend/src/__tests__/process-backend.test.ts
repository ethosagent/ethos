// V-ES-7 (plan upstream-bug-parity, fix round 1) — the reference plugin
// backend spawned bash with the host's full process.env (every ~/.ethos/.env
// secret), outside a process group, and resolved on `close`, so a timeout
// orphaned grandchildren and a backgrounded child wedged the exec. It now
// follows execution-local: env allowlist, group kill, exit + bounded drain,
// and a pre-aborted signal refuses before spawning.

import { execFileSync } from 'node:child_process';
import type { EthosPluginApi, ExecutionBackendFactory } from '@ethosagent/plugin-sdk';
import type { ExecChunk, ExecutionBackend, Logger, SecretsResolver } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import plugin from '../index';

const posix = process.platform !== 'win32';

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

function backend(): ExecutionBackend {
  let factory: ExecutionBackendFactory | undefined;
  const api = {
    registerExecutionBackend: (_name: string, f: ExecutionBackendFactory) => {
      factory = f;
    },
  } as unknown as EthosPluginApi;
  plugin.activate(api);
  if (!factory) throw new Error('plugin registered no backend');
  const made = factory({ config: {}, secrets: secretsStub, logger: loggerStub });
  if (made instanceof Promise) throw new Error('factory is synchronous');
  return made;
}

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

describe.skipIf(!posix)('process backend lifetime (V-ES-7)', () => {
  it('a timeout kills grandchildren, not just bash', async () => {
    const s = uniqueSleep();
    const started = Date.now();
    await expect(drain(backend().exec(`sleep ${s}; echo x`, { timeoutMs: 500 }))).rejects.toThrow(
      /timed out/,
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
      drain(backend().exec(`sleep ${s}; echo x`, { timeoutMs: 30_000, signal: ac.signal })),
    ).rejects.toThrow(/aborted/);
    await settle(300);
    expect(survivors(`sleep ${s}`)).toBe('');
  });

  it('a backgrounded child holding the pipe does not wedge the exec', async () => {
    const s = uniqueSleep();
    const started = Date.now();
    const chunks = await drain(backend().exec(`sleep ${s} &`, { timeoutMs: 30_000 }));
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(chunks.at(-1)).toEqual({ stream: 'exit', code: 0 });
    await settle(300);
    expect(survivors(`sleep ${s}`)).toBe('');
  });

  it('a pre-aborted signal refuses without running the command', async () => {
    const s = uniqueSleep();
    const ac = new AbortController();
    ac.abort();
    await expect(
      drain(backend().exec(`sleep ${s}`, { timeoutMs: 30_000, signal: ac.signal })),
    ).rejects.toThrow(/aborted/);
    await settle(100);
    expect(survivors(`sleep ${s}`)).toBe('');
  });
});

describe('process backend env allowlist (V-ES-7, V-ES-8)', () => {
  it('forwards operational vars and withholds secrets and .env-loaded names', async () => {
    const staged: Record<string, string> = {
      SSH_AUTH_SOCK: '/tmp/ves7-agent.sock',
      HTTPS_PROXY: 'http://proxy.ves7:3128',
      LC_CTYPE: 'UTF-8',
      VES7_API_KEY: 'ves7-secret-1',
      GITHUB_TOKEN: 'ves7-secret-2',
      AWS_REGION: 'ves7-secret-3',
      ALL_PROXY: 'ves7-secret-4',
      ETHOS_DOTENV_KEYS: 'ALL_PROXY',
    };
    const saved = new Map(Object.keys(staged).map((k) => [k, process.env[k]]));
    Object.assign(process.env, staged);
    try {
      const chunks = await drain(backend().exec('env', { env: { EXPLICIT_VAR: 'yes' } }));
      const out = chunks.map((c) => (c.stream === 'exit' ? '' : c.data)).join('');
      expect(out).toMatch(/^EXPLICIT_VAR=yes$/m);
      expect(out).toMatch(/^PATH=/m);
      expect(out).toContain('SSH_AUTH_SOCK=/tmp/ves7-agent.sock\n');
      expect(out).toContain('HTTPS_PROXY=http://proxy.ves7:3128\n');
      expect(out).toContain('LC_CTYPE=UTF-8\n');
      expect(out).not.toMatch(/ves7-secret/);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
