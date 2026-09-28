import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecChunk, Logger, SecretsResolver } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DockerExecutionBackend, ExecAbortedError, ExecTimeoutError } from '../index';

// UBP-040 — a timed-out or aborted exec in the persistent session must not
// leave the shared shell running it. Driven through a fake `docker` on PATH
// (fixtures/fake-docker) so it runs without a daemon.

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

async function drain(it: AsyncIterable<ExecChunk>): Promise<{ out: string; code?: number }> {
  let out = '';
  let code: number | undefined;
  for await (const c of it) {
    if (c.stream === 'exit') code = c.code;
    else if (c.stream === 'stdout') out += c.data;
  }
  return { out: out.trim(), ...(code !== undefined ? { code } : {}) };
}

describe.skipIf(process.platform === 'win32')('persistent session recovery (UBP-040)', () => {
  let binDir: string;
  let stateDir: string;
  const origPath = process.env.PATH;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), 'ethos-fake-docker-bin-'));
    stateDir = mkdtempSync(join(tmpdir(), 'ethos-fake-docker-state-'));
    const target = join(binDir, 'docker');
    copyFileSync(join(import.meta.dirname, 'fixtures', 'fake-docker'), target);
    chmodSync(target, 0o755);
    process.env.PATH = `${binDir}:${origPath}`;
    process.env.FAKE_DOCKER_STATE = stateDir;
  });

  afterEach(() => {
    process.env.PATH = origPath;
    delete process.env.FAKE_DOCKER_STATE;
    rmSync(binDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function makeSession() {
    const be = new DockerExecutionBackend(
      {
        config: { images: { default: 'img@sha256:abc' } },
        secrets: secretsStub,
        logger: loggerStub,
      },
      async () => true,
      async () => null,
      async () => false,
      async () => ({}),
    );
    return be.spawnSession('p');
  }

  it('the exec after a timed-out one gets a fresh shell and its own output', async () => {
    const session = makeSession();
    await expect(
      drain(session.exec('sleep 10; echo stale', { timeoutMs: 200 })),
    ).rejects.toBeInstanceOf(ExecTimeoutError);
    const started = Date.now();
    const next = await drain(session.exec('echo ok', { timeoutMs: 2_000 }));
    expect(next).toEqual({ out: 'ok', code: 0 });
    expect(Date.now() - started).toBeLessThan(2_000);
    await session.dispose();
  });

  it('the exec after an aborted one gets a fresh shell and its own output', async () => {
    const session = makeSession();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(
      drain(session.exec('sleep 10; echo stale', { timeoutMs: 30_000, signal: ac.signal })),
    ).rejects.toBeInstanceOf(ExecAbortedError);
    const next = await drain(session.exec('echo ok', { timeoutMs: 2_000 }));
    expect(next).toEqual({ out: 'ok', code: 0 });
    await session.dispose();
  });

  it('a healthy session keeps its shell state between execs', async () => {
    const session = makeSession();
    await drain(session.exec('export UBP040=kept', { timeoutMs: 2_000 }));
    expect(await drain(session.exec('echo $UBP040', { timeoutMs: 2_000 }))).toEqual({
      out: 'kept',
      code: 0,
    });
    await session.dispose();
  });
});
