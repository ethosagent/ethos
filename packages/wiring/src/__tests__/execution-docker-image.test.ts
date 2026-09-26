// `execution.docker.image` reaches the docker backend as `images.default`.
//
// The defect this guards: the backend read `config.images?.default`, and no
// production code ever set `images`, so every docker-posture `terminal` call
// refused with an EMPTY image ref. The config key alone is not the fix — the
// assertion is on what the backend factory was CONSTRUCTED with.

import { DefaultExecutionBackendRegistry } from '@ethosagent/core';
import { noopLogger } from '@ethosagent/logger';
import type {
  ExecutionBackend,
  ExecutionBackendConfig,
  PersonalityConfig,
  SecretsResolver,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createExecutionRouting } from '../compose-tools';

const SECRETS: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};

const IMAGE = `node@sha256:${'b'.repeat(64)}`;

const trader = {
  id: 'trader',
  name: 'trader',
  description: 'test',
  toolset: ['terminal'],
} as PersonalityConfig;

async function builtDockerConfig(docker?: {
  cpu?: number;
  image?: string;
}): Promise<ExecutionBackendConfig | undefined> {
  let seen: ExecutionBackendConfig | undefined;
  const registry = new DefaultExecutionBackendRegistry();
  registry.register('docker', (ctx) => {
    seen = ctx.config;
    return {
      name: 'docker',
      isAvailable: () => Promise.resolve(true),
      exec: () => {
        throw new Error('not used');
      },
      spawnSession: () => {
        throw new Error('not used');
      },
      mountsFor: () => [],
      dispose: () => Promise.resolve(),
    } as ExecutionBackend;
  });
  const routing = await createExecutionRouting({
    personalities: { get: (id: string) => (id === trader.id ? trader : undefined) },
    activePerson: trader,
    registry,
    secrets: SECRETS,
    logger: noopLogger,
    substitutionVars: { ethosHome: '/home/tester/.ethos', cwd: '/work' },
    disableDocker: false,
    // Pinned so a container-hosted run cannot resolve `local` and skip the docker arm.
    containerized: { env: {}, fileExists: () => false, readFile: () => null },
    ...(docker ? { docker } : {}),
  });
  expect(routing.posture.backend).toBe('docker');
  await routing.dispose();
  return seen;
}

describe('execution.docker.image → DockerExecutionBackend', () => {
  it('threads the configured image into images.default', async () => {
    const config = await builtDockerConfig({ cpu: 2, image: IMAGE });
    expect(config?.images).toEqual({ default: IMAGE });
    expect(config?.cpu).toBe(2);
  });

  it('passes no images at all when the key is unset (the backend then refuses by name)', async () => {
    const config = await builtDockerConfig({ cpu: 2 });
    expect(config).toBeDefined();
    expect(config?.images).toBeUndefined();
  });
});
