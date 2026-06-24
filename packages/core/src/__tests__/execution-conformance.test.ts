import type {
  ExecChunk,
  ExecutionBackend,
  MountSpec,
  PersonalityConfig,
  SandboxAttestation,
} from '@ethosagent/types';
import { isStrictAttestation } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { runExecutionConformance } from '../execution/conformance';

function createMockBackend(overrides?: {
  name?: string;
  attest?: () => SandboxAttestation;
  isAvailable?: () => Promise<boolean>;
  execChunks?: ExecChunk[];
  mountsFor?: (p: PersonalityConfig) => MountSpec[];
}): ExecutionBackend {
  return {
    name: overrides?.name ?? 'mock',
    isAvailable: overrides?.isAvailable ?? (() => Promise.resolve(false)),
    exec: async function* (): AsyncIterable<ExecChunk> {
      const chunks = overrides?.execChunks ?? [
        { stream: 'stdout', data: 'hello\n' },
        { stream: 'exit', code: 0 },
      ];
      for (const chunk of chunks) yield chunk;
    },
    spawnSession: (personalityId: string) => ({
      personalityId,
      exec: async function* (): AsyncIterable<ExecChunk> {},
      dispose: () => Promise.resolve(),
    }),
    mountsFor: overrides?.mountsFor ?? ((_p: PersonalityConfig) => []),
    dispose: () => Promise.resolve(),
    ...(overrides?.attest ? { attest: overrides.attest } : {}),
  };
}

describe('Execution conformance harness', () => {
  it('passes for a well-formed backend with attest()', async () => {
    const backend = createMockBackend({
      attest: () => ({
        readonlyRootFs: false,
        noHostMounts: false,
        egressControlled: false,
        noDockerSocket: true,
        nonRoot: false,
        noPrivileged: false,
        noCapAdd: false,
        capDropAll: false,
        noNewPrivs: false,
      }),
    });
    const result = await runExecutionConformance(backend);
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes for a backend without attest() (optional method)', async () => {
    const backend = createMockBackend();
    const result = await runExecutionConformance(backend);
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('catches an attestation with non-boolean field', async () => {
    const backend = createMockBackend({
      attest: () =>
        ({
          readonlyRootFs: 'yes',
          noHostMounts: false,
          egressControlled: false,
          noDockerSocket: true,
          nonRoot: false,
          noPrivileged: false,
          noCapAdd: false,
          capDropAll: false,
          noNewPrivs: false,
        }) as unknown as SandboxAttestation,
    });
    const result = await runExecutionConformance(backend);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('readonlyRootFs'))).toBe(true);
  });

  it('catches missing exit chunk from exec()', async () => {
    const backend = createMockBackend({
      isAvailable: () => Promise.resolve(true),
      execChunks: [{ stream: 'stdout', data: 'hello\n' }],
    });
    const result = await runExecutionConformance(backend);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('exit chunk'))).toBe(true);
  });

  it('passes when exit chunk is present', async () => {
    const backend = createMockBackend({
      isAvailable: () => Promise.resolve(true),
      execChunks: [
        { stream: 'stdout', data: 'hello\n' },
        { stream: 'exit', code: 0 },
      ],
    });
    const result = await runExecutionConformance(backend);
    expect(result.passed).toBe(true);
  });

  it('classifier-skip keys on attestation, never on name (S2)', async () => {
    // A backend named "docker" with a partial attestation should NOT be strict.
    const backend = createMockBackend({
      name: 'docker',
      attest: () => ({
        readonlyRootFs: false,
        noHostMounts: false,
        egressControlled: false,
        noDockerSocket: true,
        nonRoot: false,
        noPrivileged: false,
        noCapAdd: false,
        capDropAll: false,
        noNewPrivs: false,
      }),
    });
    const attestation = backend.attest?.();
    expect(attestation).toBeDefined();
    if (attestation) {
      // Even though the name is "docker", the attestation is partial -> NOT strict.
      expect(isStrictAttestation(attestation)).toBe(false);
    }
    const result = await runExecutionConformance(backend);
    expect(result.passed).toBe(true);
  });

  it('verifies isStrictAttestation consistency for a strict attestation', async () => {
    const backend = createMockBackend({
      attest: () => ({
        readonlyRootFs: true,
        noHostMounts: true,
        egressControlled: true,
        noDockerSocket: true,
        nonRoot: true,
        noPrivileged: true,
        noCapAdd: true,
        capDropAll: true,
        noNewPrivs: true,
      }),
    });
    const attestation = backend.attest?.();
    expect(attestation).toBeDefined();
    if (attestation) {
      expect(isStrictAttestation(attestation)).toBe(true);
    }
    const result = await runExecutionConformance(backend);
    expect(result.passed).toBe(true);
  });

  it('validates mountsFor returns well-formed MountSpecs', async () => {
    const backend = createMockBackend({
      mountsFor: () => [{ hostPath: '/tmp/test', containerPath: '/tmp/test', mode: 'ro' }],
    });
    const result = await runExecutionConformance(backend);
    expect(result.passed).toBe(true);
  });
});
