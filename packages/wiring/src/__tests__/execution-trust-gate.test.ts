import { describe, expect, it } from 'vitest';
import { isExecutionBackendAllowed } from '../execution-trust-gate';

describe('isExecutionBackendAllowed', () => {
  it('always allows built-in backends (no namespace)', () => {
    expect(isExecutionBackendAllowed('local')).toBe(true);
    expect(isExecutionBackendAllowed('docker')).toBe(true);
    expect(isExecutionBackendAllowed('ssh')).toBe(true);
  });

  it('denies plugin backends when no allowlist is configured', () => {
    expect(isExecutionBackendAllowed('my-plugin/process')).toBe(false);
    expect(isExecutionBackendAllowed('my-plugin/process', undefined)).toBe(false);
  });

  it('denies plugin backends not in the allowlist', () => {
    expect(isExecutionBackendAllowed('my-plugin/process', ['other-plugin'])).toBe(false);
  });

  it('allows plugin backends in the allowlist', () => {
    expect(isExecutionBackendAllowed('my-plugin/process', ['my-plugin'])).toBe(true);
  });

  it('matches by plugin id prefix (before /)', () => {
    expect(isExecutionBackendAllowed('acme/docker-alt', ['acme'])).toBe(true);
    expect(isExecutionBackendAllowed('acme/docker-alt', ['acme-other'])).toBe(false);
  });
});
