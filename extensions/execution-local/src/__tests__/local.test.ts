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
