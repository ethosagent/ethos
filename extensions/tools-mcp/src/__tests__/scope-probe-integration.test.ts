import { describe, expect, it, vi } from 'vitest';
import type { ScopeProbeResult } from '../index';

describe('scope probe observability recording', () => {
  it('records match as info severity', () => {
    const recordEvent = vi.fn();

    const result: ScopeProbeResult = {
      server: 'test',
      outcome: 'match',
      declaredScopes: ['read'],
      actualScopes: ['read'],
    };

    // Simulate what McpManager.onScopeProbe does
    recordEvent({
      category: 'mcp.scope_probe',
      severity: result.outcome === 'match' ? 'info' : 'warn',
      code: result.outcome,
      details: {
        server: result.server,
        declaredScopes: result.declaredScopes,
        actualScopes: result.actualScopes,
      },
    });

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'mcp.scope_probe',
        severity: 'info',
        code: 'match',
      }),
    );
  });

  it('records mismatch as warn severity', () => {
    const recordEvent = vi.fn();

    const result: ScopeProbeResult = {
      server: 'test',
      outcome: 'mismatch',
      declaredScopes: ['read', 'write'],
      actualScopes: ['read', 'admin'],
    };

    recordEvent({
      category: 'mcp.scope_probe',
      severity: result.outcome === 'match' ? 'info' : 'warn',
      code: result.outcome,
      details: {
        server: result.server,
        declaredScopes: result.declaredScopes,
        actualScopes: result.actualScopes,
      },
    });

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'mcp.scope_probe',
        severity: 'warn',
        code: 'mismatch',
      }),
    );
  });

  it('records error with error detail', () => {
    const recordEvent = vi.fn();

    const result: ScopeProbeResult = {
      server: 'test',
      outcome: 'error',
      declaredScopes: ['read'],
      actualScopes: [],
      error: 'ECONNREFUSED',
    };

    recordEvent({
      category: 'mcp.scope_probe',
      severity: 'warn',
      code: result.outcome,
      details: {
        server: result.server,
        declaredScopes: result.declaredScopes,
        actualScopes: result.actualScopes,
        error: result.error,
      },
    });

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'error',
        details: expect.objectContaining({ error: 'ECONNREFUSED' }),
      }),
    );
  });
});
