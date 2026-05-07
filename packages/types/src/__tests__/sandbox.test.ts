import { describe, expect, it } from 'vitest';
import { isStrictAttestation, type SandboxAttestation } from '../sandbox';

const allTrue: SandboxAttestation = {
  readonlyRootFs: true,
  noHostMounts: true,
  egressControlled: true,
  noDockerSocket: true,
  nonRoot: true,
  noPrivileged: true,
  noCapAdd: true,
  capDropAll: true,
  noNewPrivs: true,
};

describe('isStrictAttestation', () => {
  it('is true when every flag is true', () => {
    expect(isStrictAttestation(allTrue)).toBe(true);
  });

  it.each([
    'readonlyRootFs',
    'noHostMounts',
    'egressControlled',
    'noDockerSocket',
    'nonRoot',
    'noPrivileged',
    'noCapAdd',
    'capDropAll',
    'noNewPrivs',
  ] as const)('is false when %s is false', (key) => {
    expect(isStrictAttestation({ ...allTrue, [key]: false })).toBe(false);
  });
});
