import { DefaultExecutionBackendRegistry } from '@ethosagent/core';
import { noopLogger } from '@ethosagent/logger';
import type { ExecutionBackend, PersonalityConfig, SecretsResolver } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createExecutionRouting } from '../compose-tools';

// Lifecycle audit G6 — the docker/ssh backends were disposed TWICE: once by the
// execution routing (through the `SessionManager` wrapper, whose dispose
// cascades to the instance it wraps) and once by a walk over the registry in
// `buildInfrastructure`. Harmless only because both backends' `dispose()` is a
// no-op today. Ownership is now explicit: the execution routing is the single
// owner of every instance the registry holds, and disposes each exactly once.

const SECRETS: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};

function fakeBackend(name: string, dispose: () => void): ExecutionBackend {
  return {
    name,
    isAvailable: async () => true,
    exec: async function* () {},
    spawnSession: () => ({ exec: async function* () {}, dispose: async () => {} }) as never,
    mountsFor: () => [],
    dispose: async () => dispose(),
  } as unknown as ExecutionBackend;
}

const PERSON = { id: 'p', name: 'p', toolset: [] } as unknown as PersonalityConfig;

describe('execution backend disposal has one owner (F06 / G6)', () => {
  it('disposes every registry instance exactly once', async () => {
    const disposed: string[] = [];
    const registry = new DefaultExecutionBackendRegistry();
    registry.register('local', () => fakeBackend('local', () => disposed.push('local')));
    registry.register('ssh', () => fakeBackend('ssh', () => disposed.push('ssh')));
    await registry.resolve('local', { config: {}, secrets: SECRETS, logger: noopLogger } as never);
    await registry.resolve('ssh', { config: {}, secrets: SECRETS, logger: noopLogger } as never);

    const routing = await createExecutionRouting({
      personalities: { get: () => PERSON },
      activePerson: PERSON,
      registry,
      secrets: SECRETS,
      logger: noopLogger,
      substitutionVars: { ethosHome: '/tmp/ethos', cwd: '/tmp' },
      disableDocker: true,
      containerized: { env: {}, fileExists: () => false, readFile: () => null },
    });

    await routing.dispose();
    expect(disposed.sort()).toEqual(['local', 'ssh']);
    // Idempotent: a second dispose (a host that calls it twice) disposes nothing again.
    await routing.dispose();
    expect(disposed.sort()).toEqual(['local', 'ssh']);
  });

  it('buildInfrastructure no longer walks the registry itself', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const src = await readFile(join(import.meta.dirname, '..', 'build-infrastructure.ts'), 'utf8');
    expect(src).not.toContain('executionBackends.get(name)?.dispose()');
    // …and says who does.
    expect(src).toContain('createExecutionRouting');
  });
});

// Keeps the unused-import lint honest when the fake above changes shape.
void vi;
