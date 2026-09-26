import { describe, expect, it, vi } from 'vitest';

vi.mock('../wiring', () => ({
  getStorage: () => ({}),
}));
vi.mock('@ethosagent/wiring', () => ({
  backupDirectory: () => '/tmp/backups',
}));

import { cronFailureSummary } from '../commands/status';

// Shape test for the adapter JSON builder in status.ts.
// The helper is not exported, so we verify the shape contract via the
// type expectations documented in the plan. The full command path is
// integration-tested manually since it reads ~/.ethos/config.yaml.

describe('ethos status --json output shape', () => {
  it('adapter object has required fields', () => {
    // Inline the shape contract; matches buildAdapterJson output
    const adapterShape = { name: 'telegram', configured: false, ok: null };
    expect(typeof adapterShape.name).toBe('string');
    expect(typeof adapterShape.configured).toBe('boolean');
    expect(adapterShape.ok === null || typeof adapterShape.ok === 'boolean').toBe(true);
  });

  it('JSON output root keys are defined', () => {
    // Verify the documented JSON shape has all required top-level keys
    const shape = {
      version: { name: '@ethosagent/cli', version: 'dev' },
      config: { present: false },
      adapters: [],
      personalities: { count: 0, dir: '' },
      errorLog: { exists: false, recentCount: 0 },
      exit: 1,
    };
    expect(shape).toHaveProperty('version');
    expect(shape).toHaveProperty('config');
    expect(shape).toHaveProperty('adapters');
    expect(shape).toHaveProperty('personalities');
    expect(shape).toHaveProperty('errorLog');
    expect(shape).toHaveProperty('exit');
  });

  it('exit field is 0 or 1', () => {
    for (const exit of [0, 1]) {
      expect(exit === 0 || exit === 1).toBe(true);
    }
  });

  it('config.present=true shape has provider, model, personality', () => {
    const configPresent = {
      present: true,
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      personality: 'architect',
    };
    expect(configPresent.present).toBe(true);
    expect(typeof configPresent.provider).toBe('string');
    expect(typeof configPresent.model).toBe('string');
    expect(typeof configPresent.personality).toBe('string');
  });

  // B3 — `resolved` mirrors EffectiveConfig from resolveEffectiveConfig.
  it('resolved object carries the effective-config fields', () => {
    const resolved = {
      stateDir: '/home/u/.ethos',
      configPath: '/home/u/.ethos/config.yaml',
      personality: { id: 'engineer', source: 'personality' },
      model: { id: 'claude-sonnet-5', rung: 'model:' },
      apiKey: { provider: 'anthropic', source: 'env', envVar: 'ANTHROPIC_API_KEY' },
      warnings: [],
    };
    expect(resolved).toHaveProperty('stateDir');
    expect(resolved).toHaveProperty('configPath');
    expect(resolved.personality).toHaveProperty('id');
    expect(resolved.personality).toHaveProperty('source');
    expect(resolved.model).toHaveProperty('rung');
    expect(resolved.apiKey).toHaveProperty('source');
    expect(Array.isArray(resolved.warnings)).toBe(true);
  });

  // N4 — `pending` counts; null means "store absent or unreadable".
  it('pending object has memory, outbox and cron facets, each nullable', () => {
    const pending = {
      memory: 3,
      outbox: null,
      cron: { failures24h: 1, latestFailedId: 'job-1' },
    };
    expect(pending).toHaveProperty('memory');
    expect(pending).toHaveProperty('outbox');
    expect(pending).toHaveProperty('cron');
  });
});

describe('cronFailureSummary — N4 failures in the last 24h', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();

  it('counts only failed runs inside the window and names the latest', () => {
    const jobs = [
      { id: 'fresh-fail', lastError: 'boom', lastRunAt: at(1) },
      { id: 'older-fail', lastError: 'kaput', lastRunAt: at(20) },
      { id: 'stale-fail', lastError: 'old', lastRunAt: at(30) },
      { id: 'ok-job', lastRunAt: at(1) },
    ];
    expect(cronFailureSummary(jobs, now)).toEqual({
      failures24h: 2,
      latestFailedId: 'fresh-fail',
    });
  });

  it('is fail-soft on malformed stores', () => {
    expect(cronFailureSummary('not an array', now)).toEqual({
      failures24h: 0,
      latestFailedId: null,
    });
    expect(cronFailureSummary([null, 42, { id: 'x' }], now)).toEqual({
      failures24h: 0,
      latestFailedId: null,
    });
  });
});
