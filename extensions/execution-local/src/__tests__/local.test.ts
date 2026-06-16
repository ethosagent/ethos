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
});
