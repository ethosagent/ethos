import type {
  ExecChunk,
  ExecutionBackend,
  ExecutionBackendConfig,
  Logger,
  PersonalityConfig,
  SecretsResolver,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { DefaultExecutionBackendRegistry } from '../providers/execution-registry';

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

const ctx = { config: {} as ExecutionBackendConfig, secrets: secretsStub, logger: loggerStub };

function fakeBackend(name: string): ExecutionBackend {
  return {
    name,
    isAvailable: () => Promise.resolve(true),
    exec: async function* (): AsyncIterable<ExecChunk> {},
    spawnSession: (personalityId: string) => ({
      personalityId,
      exec: async function* (): AsyncIterable<ExecChunk> {},
      dispose: () => Promise.resolve(),
    }),
    mountsFor: (_p: PersonalityConfig) => [],
    dispose: () => Promise.resolve(),
  };
}

describe('DefaultExecutionBackendRegistry', () => {
  it('resolves and caches instances; get returns them; list returns names', async () => {
    const reg = new DefaultExecutionBackendRegistry();
    reg.register('a', () => fakeBackend('a'));
    reg.register('b', () => fakeBackend('b'));

    const a = await reg.resolve('a', ctx);
    const b = await reg.resolve('b', ctx);

    expect(reg.get('a')).toBe(a);
    expect(reg.get('b')).toBe(b);
    expect(reg.list().sort()).toEqual(['a', 'b']);
  });

  it('throws on duplicate registration', () => {
    const reg = new DefaultExecutionBackendRegistry();
    reg.register('a', () => fakeBackend('a'));
    expect(() => reg.register('a', () => fakeBackend('a'))).toThrow();
  });

  it('throws when resolving an unregistered backend', async () => {
    const reg = new DefaultExecutionBackendRegistry();
    await expect(reg.resolve('missing', ctx)).rejects.toThrow();
  });

  it('get returns undefined for a registered-but-unresolved backend', () => {
    const reg = new DefaultExecutionBackendRegistry();
    reg.register('a', () => fakeBackend('a'));
    expect(reg.get('a')).toBeUndefined();
  });

  it('resolving twice returns the same cached instance and does not re-invoke the factory', async () => {
    const reg = new DefaultExecutionBackendRegistry();
    let calls = 0;
    reg.register('a', () => {
      calls += 1;
      return fakeBackend('a');
    });

    const first = await reg.resolve('a', ctx);
    const second = await reg.resolve('a', ctx);

    expect(first).toBe(second);
    expect(calls).toBe(1);
  });
});
