import type { Logger, PersonalityConfig, SecretsResolver } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { SshExecutionBackend } from '../index';

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

describe('SshExecutionBackend', () => {
  it('isAvailable resolves false when no host is configured', async () => {
    const be = new SshExecutionBackend({ config: {}, secrets: secretsStub, logger: loggerStub });
    expect(await be.isAvailable()).toBe(false);
  });

  it('mountsFor returns no mounts (not mount-confined)', () => {
    const be = new SshExecutionBackend({ config: {}, secrets: secretsStub, logger: loggerStub });
    expect(be.mountsFor({} as PersonalityConfig)).toEqual([]);
  });
});
