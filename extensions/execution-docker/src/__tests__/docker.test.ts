import type { Logger, SecretsResolver } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  buildDockerArgs,
  DockerExecutionBackend,
  DockerUnavailableError,
  InvalidImageRefError,
} from '../index';

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

describe('buildDockerArgs', () => {
  it('includes hardening flags, non-root user, and digest-pinned image', () => {
    const args = buildDockerArgs({
      image: 'python@sha256:abc123',
      uid: 1000,
      gid: 1000,
      memoryMb: 256,
      networkMode: 'none',
      stdin: false,
      cmd: 'echo hi',
      containerName: 'x',
    });
    for (const expected of [
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--cpus',
      '2',
      '--pids-limit',
      '256',
      '--memory=256m',
      '--memory-swap',
      '256m',
      '--network',
      'none',
      '--user',
      '1000:1000',
      '--pull=never',
      'python@sha256:abc123',
    ]) {
      expect(args).toContain(expected);
    }
  });

  it('throws InvalidImageRefError when the image is not digest-pinned', () => {
    expect(() =>
      buildDockerArgs({
        image: 'python:3.12-slim',
        uid: 1000,
        gid: 1000,
        memoryMb: 256,
        networkMode: 'none',
        stdin: false,
        cmd: 'echo hi',
        containerName: 'x',
      }),
    ).toThrow(InvalidImageRefError);
  });

  it('accepts a digest-pinned image and includes the ref plus --pull=never', () => {
    const args = buildDockerArgs({
      image: 'python@sha256:def456',
      uid: 1000,
      gid: 1000,
      memoryMb: 256,
      networkMode: 'none',
      stdin: false,
      cmd: 'echo hi',
      containerName: 'x',
    });
    expect(args).toContain('python@sha256:def456');
    expect(args).toContain('--pull=never');
  });
});

describe('DockerExecutionBackend', () => {
  it('throws DockerUnavailableError without falling back to local', async () => {
    const be = new DockerExecutionBackend(
      {
        config: { images: { default: 'python@sha256:abc' } },
        secrets: secretsStub,
        logger: loggerStub,
      },
      async () => false,
    );
    await expect(
      (async () => {
        for await (const _ of be.exec('echo hi', {})) {
          // drain
        }
      })(),
    ).rejects.toBeInstanceOf(DockerUnavailableError);
  });
});
