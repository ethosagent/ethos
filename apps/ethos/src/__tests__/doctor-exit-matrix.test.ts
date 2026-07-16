import { describe, expect, it } from 'vitest';
import { computeDoctorExit, type DoctorFailFlags } from '../commands/doctor';

const clean: DoctorFailFlags = {
  coreFailure: false,
  configuredMissing: false,
  awsFailed: false,
  requiredSecretMissing: false,
  dbUnopenable: false,
  gatewayStale: false,
  channelRejected: false,
  channelUnreachable: false,
};

describe('computeDoctorExit — W2.3 exit-code matrix', () => {
  it('exits 0 when everything is healthy', () => {
    expect(computeDoctorExit(clean)).toBe(0);
  });

  it('exits 1 on a rejected channel token (auth-fail)', () => {
    expect(computeDoctorExit({ ...clean, channelRejected: true })).toBe(1);
  });

  it('exits with the DISTINCT warn code (2) on an unreachable channel probe', () => {
    expect(computeDoctorExit({ ...clean, channelUnreachable: true })).toBe(2);
  });

  it('auth-fail (1) and unreachable are distinct codes', () => {
    const rejected = computeDoctorExit({ ...clean, channelRejected: true });
    const unreachable = computeDoctorExit({ ...clean, channelUnreachable: true });
    expect(rejected).not.toBe(unreachable);
  });

  it('a hard failure outranks an unreachable warn', () => {
    expect(computeDoctorExit({ ...clean, channelRejected: true, channelUnreachable: true })).toBe(
      1,
    );
  });

  it('exits 1 on a stale gateway heartbeat', () => {
    expect(computeDoctorExit({ ...clean, gatewayStale: true })).toBe(1);
  });

  it('exits 1 on an unopenable sessions.db', () => {
    expect(computeDoctorExit({ ...clean, dbUnopenable: true })).toBe(1);
  });

  it('exits 1 on a missing required secret / core SDK', () => {
    expect(computeDoctorExit({ ...clean, requiredSecretMissing: true })).toBe(1);
    expect(computeDoctorExit({ ...clean, coreFailure: true })).toBe(1);
  });
});
