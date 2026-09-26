// DKR-001 — `attest()` reports what the container actually is, read from
// `docker inspect`, and reports every property unproven (false) where it
// cannot tell: before any container ran, while one is still being inspected,
// or after one ran that could not be inspected.
import { EventEmitter } from 'node:events';
import type {
  ExecutionBackendConfig,
  Logger,
  SandboxAttestation,
  SecretsResolver,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: () => true, end: () => {} };
  kill(): boolean {
    return true;
  }
}

// Every `docker run` in this file is a fake that exits 0 on the next tick.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = new FakeChild();
      setImmediate(() => child.emit('close', 0));
      return child;
    }),
  };
});

const { attestationFromInspect, DockerExecutionBackend } = await import('../index');

const secrets: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};
const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};
const config: ExecutionBackendConfig = { images: { default: 'img@sha256:abc' } };

const UNPROVEN: SandboxAttestation = {
  readonlyRootFs: false,
  noHostMounts: false,
  egressControlled: false,
  noDockerSocket: false,
  nonRoot: false,
  noPrivileged: false,
  noCapAdd: false,
  capDropAll: false,
  noNewPrivs: false,
};

/** `docker inspect` output for a container this backend would start. */
function inspectJson(over: { user?: string; network?: string; mounts?: unknown[] } = {}) {
  return [
    {
      Config: { User: over.user ?? '1000:1000' },
      HostConfig: {
        Privileged: false,
        CapAdd: null,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        ReadonlyRootfs: false,
        NetworkMode: over.network ?? 'none',
      },
      Mounts: over.mounts ?? [],
    },
  ];
}

async function drain(it: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of it) {
    // consume
  }
}

describe('attestationFromInspect', () => {
  it('reports the hardening flags a non-root, network-none, mount-free container carries', () => {
    expect(attestationFromInspect(inspectJson())).toEqual({
      readonlyRootFs: false,
      noHostMounts: true,
      egressControlled: true,
      noDockerSocket: true,
      nonRoot: true,
      noPrivileged: true,
      noCapAdd: true,
      capDropAll: true,
      noNewPrivs: true,
    });
  });

  it('a root or unset user is not nonRoot', () => {
    expect(attestationFromInspect(inspectJson({ user: '0:0' })).nonRoot).toBe(false);
    expect(attestationFromInspect(inspectJson({ user: 'root' })).nonRoot).toBe(false);
    // Empty = the image's own USER, which inspect does not resolve: unknown.
    expect(attestationFromInspect(inspectJson({ user: '' })).nonRoot).toBe(false);
  });

  it('a bridge network is not egressControlled', () => {
    expect(attestationFromInspect(inspectJson({ network: 'bridge' })).egressControlled).toBe(false);
  });

  it('a bind mount of the docker socket, or of any directory above it, is reported', () => {
    for (const source of ['/var/run/docker.sock', '/var/run', '/run', '/']) {
      const a = attestationFromInspect(
        inspectJson({ mounts: [{ Type: 'bind', Source: source, Destination: '/x' }] }),
      );
      expect(a.noDockerSocket, source).toBe(false);
      expect(a.noHostMounts, source).toBe(false);
    }
    const workdir = attestationFromInspect(
      inspectJson({ mounts: [{ Type: 'bind', Source: '/home/u/project', Destination: '/w' }] }),
    );
    expect(workdir.noDockerSocket).toBe(true);
    expect(workdir.noHostMounts).toBe(false);
  });

  it('anything it cannot read is unproven', () => {
    expect(attestationFromInspect(null)).toEqual(UNPROVEN);
    expect(attestationFromInspect('not json')).toEqual(UNPROVEN);
    expect(attestationFromInspect([{}])).toEqual(UNPROVEN);
  });
});

describe('DockerExecutionBackend.attest()', () => {
  const available = async () => true;
  const noDriver = async () => null;
  const noProbe = async () => false;

  it('attests nothing before any container has been inspected', () => {
    const be = new DockerExecutionBackend({ config, secrets, logger }, available);
    expect(be.attest()).toEqual(UNPROVEN);
  });

  it('reports the inspected container after an exec — a root container is not nonRoot', async () => {
    const be = new DockerExecutionBackend(
      { config, secrets, logger },
      available,
      noDriver,
      noProbe,
      async () => inspectJson({ user: '0:0' }),
    );
    await drain(be.exec('true', {}));
    await vi.waitFor(() => expect(be.attest().capDropAll).toBe(true));
    expect(be.attest().nonRoot).toBe(false);
    expect(be.attest().egressControlled).toBe(true);
  });

  it('a property holds only while it held for every container the backend ran', async () => {
    let user = '1000:1000';
    const be = new DockerExecutionBackend(
      { config, secrets, logger },
      available,
      noDriver,
      noProbe,
      async () => inspectJson({ user }),
    );
    await drain(be.exec('true', {}));
    await vi.waitFor(() => expect(be.attest().nonRoot).toBe(true));
    user = '0:0';
    await drain(be.exec('true', {}));
    await vi.waitFor(() => expect(be.attest().capDropAll).toBe(true));
    expect(be.attest().nonRoot).toBe(false);
  });

  it('a container that could not be inspected leaves every property unproven', async () => {
    const be = new DockerExecutionBackend(
      { config, secrets, logger },
      available,
      noDriver,
      noProbe,
      async () => null,
    );
    await drain(be.exec('true', {}));
    await new Promise((r) => setTimeout(r, 50));
    expect(be.attest()).toEqual(UNPROVEN);
  });
});
