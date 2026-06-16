import type { Constitution, PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  type ContainerizedDetectionInput,
  constitutionForbidsLocal,
  detectContainerized,
  resolveExecutionPosture,
} from '../resolve-execution-posture';

function p(extra: Partial<PersonalityConfig> & Record<string, unknown>): PersonalityConfig {
  return { id: 'p', name: 'p', ...extra } as unknown as PersonalityConfig;
}

// Containerized detection input that finds NOTHING — the resolver's default
// would otherwise probe the real host (which may be a container in CI).
const NOT_CONTAINERIZED: ContainerizedDetectionInput = {
  env: {},
  fileExists: () => false,
  readFile: () => null,
};

describe('resolveExecutionPosture — backend selection', () => {
  it('selects docker for an exec-bearing toolset', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
    });
    expect(posture.backend).toBe('docker');
  });

  it('selects none for a chat-only personality', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['memory_read', 'web_search'] }),
      containerized: NOT_CONTAINERIZED,
    });
    expect(posture.backend).toBe('none');
  });

  it('selects none when toolset is absent (never silently local)', () => {
    const posture = resolveExecutionPosture({
      personality: p({}),
      containerized: NOT_CONTAINERIZED,
    });
    expect(posture.backend).toBe('none');
  });

  it('honors an explicit execution override over tool inference', () => {
    expect(
      resolveExecutionPosture({
        personality: p({ toolset: ['terminal'], execution: 'local' }),
        containerized: NOT_CONTAINERIZED,
      }).backend,
    ).toBe('local');
    expect(
      resolveExecutionPosture({
        personality: p({ toolset: ['terminal'], execution: 'ssh' }),
        containerized: NOT_CONTAINERIZED,
      }).backend,
    ).toBe('ssh');
    expect(
      resolveExecutionPosture({
        personality: p({ toolset: ['terminal'], execution: 'none' }),
        containerized: NOT_CONTAINERIZED,
      }).backend,
    ).toBe('none');
  });

  it('ignores an unrecognized override and falls back to inference', () => {
    expect(
      resolveExecutionPosture({
        personality: p({ toolset: ['terminal'], execution: 'bogus' }),
        containerized: NOT_CONTAINERIZED,
      }).backend,
    ).toBe('docker');
  });

  it('routes an exec personality to local when Ethos is containerized', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: { env: { ETHOS_EXECUTION_BACKEND: 'local' } },
    });
    expect(posture.backend).toBe('local');
    expect(posture.containerized).toBe(true);
  });

  it('does NOT mark local-via-override as containerized', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'], execution: 'local' }),
      containerized: NOT_CONTAINERIZED,
    });
    expect(posture.backend).toBe('local');
    expect(posture.containerized).toBe(false);
  });
});

describe('resolveExecutionPosture — network + memory + scratch', () => {
  it('defaults network to none and memory to 256MB', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
    });
    expect(posture.networkMode).toBe('none');
    expect(posture.memoryMb).toBe(256);
  });

  it('resolves bridge when safety.network is set without an allowlist', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'], safety: { network: {} } }),
      containerized: NOT_CONTAINERIZED,
    });
    expect(posture.networkMode).toBe('bridge');
  });

  it('includes /tmp scratch when docker mounts do not cover it', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
      mounts: [{ hostPath: '/work', containerPath: '/work', mode: 'rw' }],
    });
    expect(posture.scratchPaths).toContain('/tmp');
  });

  it('omits scratch + mounts for a non-docker posture', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'], execution: 'local' }),
      containerized: NOT_CONTAINERIZED,
      mounts: [{ hostPath: '/work', containerPath: '/work', mode: 'rw' }],
    });
    expect(posture.mounts).toEqual([]);
    expect(posture.scratchPaths).toEqual([]);
  });
});

describe('detectContainerized', () => {
  it('detects nothing on a bare host', () => {
    expect(detectContainerized(NOT_CONTAINERIZED)).toEqual({
      containerized: false,
      explicit: false,
    });
  });

  it('honors the ETHOS_EXECUTION_BACKEND=local env override (explicit)', () => {
    const d = detectContainerized({ env: { ETHOS_EXECUTION_BACKEND: 'local' } });
    expect(d).toEqual({
      containerized: true,
      signal: 'env:ETHOS_EXECUTION_BACKEND=local',
      explicit: true,
    });
  });

  it('honors execution.containerized: true config (explicit)', () => {
    const d = detectContainerized({ ...NOT_CONTAINERIZED, containerizedConfig: true });
    expect(d).toEqual({
      containerized: true,
      signal: 'config:execution.containerized',
      explicit: true,
    });
  });

  it('auto-detects /.dockerenv', () => {
    const d = detectContainerized({
      env: {},
      fileExists: (path) => path === '/.dockerenv',
      readFile: () => null,
    });
    expect(d).toEqual({ containerized: true, signal: 'detect:/.dockerenv', explicit: false });
  });

  it('auto-detects a docker match in /proc/1/cgroup', () => {
    const d = detectContainerized({
      env: {},
      fileExists: () => false,
      readFile: (path) => (path === '/proc/1/cgroup' ? '12:cpuset:/docker/abc123' : null),
    });
    expect(d).toEqual({ containerized: true, signal: 'detect:/proc/1/cgroup', explicit: false });
  });

  it('auto-detects KUBERNETES_SERVICE_HOST', () => {
    const d = detectContainerized({
      env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' },
      fileExists: () => false,
      readFile: () => null,
    });
    expect(d).toEqual({
      containerized: true,
      signal: 'detect:KUBERNETES_SERVICE_HOST',
      explicit: false,
    });
  });

  it('does not match an unrelated cgroup', () => {
    const d = detectContainerized({
      env: {},
      fileExists: () => false,
      readFile: () => '12:cpuset:/user.slice',
    });
    expect(d.containerized).toBe(false);
  });
});

describe('resolveExecutionPosture — A1 docker-absent decision', () => {
  it('produces a consent-allowed decision when the daemon is down (no silent fallback)', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
      dockerAvailable: false,
    });
    // Posture stays docker — no silent local fallback.
    expect(posture.backend).toBe('docker');
    expect(posture.dockerAbsent).toEqual({
      blocked: true,
      canInstall: true,
      canConsentLocal: true,
    });
  });

  it('withholds the consent option when the constitution forbids local (forbidLocal)', () => {
    const constitution: Constitution = { execution: { forbidLocal: true } };
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
      dockerAvailable: false,
      constitution,
    });
    expect(posture.dockerAbsent?.canConsentLocal).toBe(false);
    expect(posture.dockerAbsent?.consentForbiddenReason).toMatch(/forbids the local posture/);
  });

  it('withholds the consent option when requireSandbox is set', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
      dockerAvailable: false,
      constitution: { execution: { requireSandbox: true } },
    });
    expect(posture.dockerAbsent?.canConsentLocal).toBe(false);
  });

  it('produces no A1 state when the daemon is available', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
      dockerAvailable: true,
    });
    expect(posture.dockerAbsent).toBeUndefined();
  });

  it('produces no A1 state for a non-docker posture even when daemon is down', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'], execution: 'local' }),
      containerized: NOT_CONTAINERIZED,
      dockerAvailable: false,
    });
    expect(posture.dockerAbsent).toBeUndefined();
  });
});

describe('resolveExecutionPosture — F1 docker-unbuildable honest fallback', () => {
  it('resolves an honest local posture when docker is disabled in-process (constitution permits)', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
      dockerBuildable: false,
    });
    // Honest: backend reflects what actually runs (host), not Docker.
    expect(posture.backend).toBe('local');
    expect(posture.hostFallback).toEqual({ reason: 'docker-disabled' });
    // Not the containerized case — Ethos is not in a container here.
    expect(posture.containerized).toBe(false);
    expect(posture.dockerAbsent).toBeUndefined();
  });

  it('stays a docker hard-fail when docker is disabled but the constitution forbids local', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
      dockerBuildable: false,
      constitution: { execution: { forbidLocal: true } },
    });
    // Never silently runs host: posture stays docker with no consent escape.
    expect(posture.backend).toBe('docker');
    expect(posture.hostFallback).toBeUndefined();
    expect(posture.dockerAbsent).toEqual({
      blocked: true,
      canInstall: true,
      canConsentLocal: false,
      consentForbiddenReason: expect.stringMatching(/forbids the local posture/),
    });
  });

  it('keeps the docker posture (no fallback) when dockerBuildable is unset', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
    });
    expect(posture.backend).toBe('docker');
    expect(posture.hostFallback).toBeUndefined();
  });

  it('does not fall back a chat-only personality (no exec tool)', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['memory_read'] }),
      containerized: NOT_CONTAINERIZED,
      dockerBuildable: false,
    });
    expect(posture.backend).toBe('none');
    expect(posture.hostFallback).toBeUndefined();
  });
});

describe('constitutionForbidsLocal', () => {
  it('is false for an empty constitution', () => {
    expect(constitutionForbidsLocal(undefined)).toBe(false);
    expect(constitutionForbidsLocal({})).toBe(false);
  });
  it('is true when forbidLocal or requireSandbox is set', () => {
    expect(constitutionForbidsLocal({ execution: { forbidLocal: true } })).toBe(true);
    expect(constitutionForbidsLocal({ execution: { requireSandbox: true } })).toBe(true);
  });
});
