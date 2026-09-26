import { describe, expect, it, vi } from 'vitest';

// N4 (plan ux-feedback-and-config-clarity) — `cron list`'s last-run outcome
// line, derived from the two fields the cron store records per job
// (`lastRunAt` + `lastError`). The store keeps no per-run history and never
// clears `lastError` on a later success — that limitation is the helper's
// doc comment, not something this test can fix.

vi.mock('../wiring', () => ({
  getStorage: () => ({}),
  getEthosObservability: () => ({}),
  createAgentLoop: async () => ({}),
}));

import { cronLastOutcome } from '../commands/cron';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

describe('cronLastOutcome', () => {
  it('reports never for a job that has not run', () => {
    expect(cronLastOutcome({}, NOW)).toBe('never');
  });

  it('reports ok with a relative age for a clean last run', () => {
    expect(cronLastOutcome({ lastRunAt: at(120) }, NOW)).toBe('ok 2h ago');
    expect(cronLastOutcome({ lastRunAt: at(3) }, NOW)).toBe('ok 3m ago');
  });

  it('reports failed when the store carries a lastError', () => {
    expect(cronLastOutcome({ lastRunAt: at(10), lastError: 'boom' }, NOW)).toBe('failed 10m ago');
  });

  it('falls back to the raw timestamp when it does not parse', () => {
    expect(cronLastOutcome({ lastRunAt: 'not-a-date' }, NOW)).toBe('ok not-a-date');
  });
});
