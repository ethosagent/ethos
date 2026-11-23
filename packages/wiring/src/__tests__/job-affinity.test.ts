import { describe, expect, it } from 'vitest';
import { resolveJobAffinity } from '../job-affinity';

// durable-background-jobs D6 — which loops may auto-resume their jobs after a
// restart: only those with an identity that survives it.

describe('resolveJobAffinity', () => {
  it('a bot key wins over a host label and is stable', () => {
    expect(resolveJobAffinity('web', { originBotKey: 'b1', jobAffinity: 'serve' })).toEqual({
      affinity: 'web:b1',
      resumeAffinity: 'web:b1',
    });
  });

  it('a host label is namespaced under `host:` so it cannot collide with a bot key', () => {
    expect(resolveJobAffinity('web', { jobAffinity: 'serve' })).toEqual({
      affinity: 'web:host:serve',
      resumeAffinity: 'web:host:serve',
    });
  });

  it('no identity falls back to a pid affinity that never auto-resumes', () => {
    expect(resolveJobAffinity('cli', {})).toEqual({ affinity: `cli:pid-${process.pid}` });
  });
});
