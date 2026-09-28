// V-ES-6 — a signal that is already aborted refuses BEFORE bash is spawned, so
// the command's side effects never start (the same rule execution-ssh follows).
// Asserted on the spawn call itself: a kill sent right after spawn usually
// lands before bash runs anything, so a marker-file check would pass by luck.

import type { Logger, SecretsResolver } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';

const spawnSpy = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  spawnSpy.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnSpy };
});

const { ExecAbortedError, LocalExecutionBackend } = await import('../index');

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

async function drain(it: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of it) {
    // consume
  }
}

describe('LocalExecutionBackend pre-aborted signal (V-ES-6)', () => {
  it.each(['exec', 'session'] as const)('%s refuses without spawning', async (via) => {
    spawnSpy.mockClear();
    const be = new LocalExecutionBackend({ config: {}, secrets: secretsStub, logger: loggerStub });
    const ac = new AbortController();
    ac.abort();
    const opts = { signal: ac.signal };
    const it = via === 'exec' ? be.exec('true', opts) : be.spawnSession('p').exec('true', opts);
    await expect(drain(it)).rejects.toBeInstanceOf(ExecAbortedError);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('an unaborted signal still spawns', async () => {
    spawnSpy.mockClear();
    const be = new LocalExecutionBackend({ config: {}, secrets: secretsStub, logger: loggerStub });
    await drain(be.exec('true', { signal: new AbortController().signal }));
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });
});
