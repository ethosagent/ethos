import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeTokenScopes } from '../scope-probe';

function mockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
}

describe('probeTokenScopes', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns match when actual scopes equal declared scopes', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ active: true, scope: 'read write' }),
    });
    const result = await probeTokenScopes(
      'test-server',
      'http://auth/introspect',
      ['read', 'write'],
      'tok_123',
      mockLogger(),
    );
    expect(result.outcome).toBe('match');
    expect(result.actualScopes).toEqual(['read', 'write']);
  });

  it('returns mismatch when scopes differ', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ active: true, scope: 'read admin' }),
    });
    const logger = mockLogger();
    const result = await probeTokenScopes(
      'test-server',
      'http://auth/introspect',
      ['read', 'write'],
      'tok_123',
      logger,
    );
    expect(result.outcome).toBe('mismatch');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('returns inactive when token is not active', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ active: false }),
    });
    const result = await probeTokenScopes(
      'test-server',
      'http://auth/introspect',
      ['read'],
      'tok_123',
      mockLogger(),
    );
    expect(result.outcome).toBe('inactive');
  });

  it('returns error on HTTP failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });
    const result = await probeTokenScopes(
      'test-server',
      'http://auth/introspect',
      ['read'],
      'tok_123',
      mockLogger(),
    );
    expect(result.outcome).toBe('error');
    expect(result.error).toContain('500');
  });

  it('returns error on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await probeTokenScopes(
      'test-server',
      'http://auth/introspect',
      ['read'],
      'tok_123',
      mockLogger(),
    );
    expect(result.outcome).toBe('error');
    expect(result.error).toContain('ECONNREFUSED');
  });
});
