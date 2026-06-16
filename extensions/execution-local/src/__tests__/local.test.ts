import type { ExecChunk, Logger, SecretsResolver } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { LocalExecutionBackend } from '../index';

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
