import { describe, expect, it } from 'vitest';
import { installScanEvent } from '../observability/install-scan';

const yellow = {
  severity: 'yellow' as const,
  rule: 'hidden-unicode',
  message: 'Contains invisible characters',
  excerpt: 'SECRET-LOOKING EXCERPT',
};

describe('installScanEvent', () => {
  it('maps an unacknowledged yellow to needs_ack and never carries excerpts or messages', () => {
    const event = installScanEvent({
      kind: 'plugin',
      source: 'some-plugin',
      tier: 'community',
      scan: { findings: [yellow, yellow], hasRed: false, hasYellow: true },
      decision: { allowed: false, blockedBy: 'yellow findings require acknowledgment' },
    });

    expect(event).toEqual({
      code: 'install.scan.needs_ack',
      severity: 'warn',
      details: {
        kind: 'plugin',
        source: 'some-plugin',
        tier: 'community',
        verdict: 'needs_ack',
        blockedBy: 'yellow findings require acknowledgment',
        findingCount: 2,
        redCount: 0,
        yellowCount: 1 + 1,
        rules: ['hidden-unicode'],
      },
    });
    expect(JSON.stringify(event)).not.toContain('SECRET-LOOKING EXCERPT');
    expect(JSON.stringify(event)).not.toContain('invisible characters');
  });

  it('maps an allowed scan with findings to warn', () => {
    const event = installScanEvent({
      kind: 'skill',
      source: 'builtin/x',
      tier: 'builtin',
      scan: { findings: [yellow], hasRed: false, hasYellow: true },
      decision: { allowed: true },
    });
    expect(event.code).toBe('install.scan.warn');
    expect(event.severity).toBe('info');
  });

  it('removes URL userinfo from the source, so a token in an npm spec is not logged', () => {
    const event = installScanEvent({
      kind: 'plugin',
      source: 'git+https://ghp_abc123@github.com/o/r.git',
      tier: 'community',
      scan: { findings: [], hasRed: false, hasYellow: false },
      decision: { allowed: true },
    });
    expect(event.details.source).toBe('git+https://github.com/o/r.git');
  });
});
