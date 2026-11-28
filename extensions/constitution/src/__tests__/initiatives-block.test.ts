import { InMemoryStorage } from '@ethosagent/storage-fs';
import { CONSTITUTION_INITIATIVES_KEYS } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { clampInitiativeBudgets, loadConstitution } from '../index';

async function load(yaml: string) {
  const storage = new InMemoryStorage();
  await storage.mkdir('/home');
  await storage.write('/home/constitution.yaml', yaml);
  return loadConstitution(storage, '/home');
}

describe('constitution initiatives block', () => {
  it('initiatives block validates', async () => {
    const r = await load(
      [
        'initiatives:',
        '  enabled: false',
        '  maxUsdPerDay: 10',
        '  maxUsdPerDayPerPersonality: 4',
        '  selfStartPoolUsdPerDay: 0.5',
        '  maxSelfStarted: 2',
        '  readableRoots:',
        '    - /srv/docs',
      ].join('\n'),
    );
    expect(r).toEqual({
      status: 'loaded',
      constitution: {
        initiatives: {
          enabled: false,
          maxUsdPerDay: 10,
          maxUsdPerDayPerPersonality: 4,
          selfStartPoolUsdPerDay: 0.5,
          maxSelfStarted: 2,
          readableRoots: ['/srv/docs'],
        },
      },
    });
    expect(CONSTITUTION_INITIATIVES_KEYS).toEqual([
      'enabled',
      'maxUsdPerDay',
      'maxUsdPerDayPerPersonality',
      'selfStartPoolUsdPerDay',
      'maxSelfStarted',
      'readableRoots',
    ]);
  });

  it('unknown key inside initiatives fails', async () => {
    const r = await load('initiatives:\n  allowWrites: true\n');
    expect(r.status).toBe('malformed');
    expect(r.status === 'malformed' && r.error).toContain('allowWrites');
  });

  it('negative or non-finite numbers fail', async () => {
    for (const bad of ['-1', '.inf', '.nan', '"5"']) {
      const r = await load(`initiatives:\n  maxUsdPerDay: ${bad}\n`);
      expect(r.status, bad).toBe('malformed');
    }
    for (const bad of ['1.5', '-1', '.inf']) {
      const r = await load(`initiatives:\n  maxSelfStarted: ${bad}\n`);
      expect(r.status, bad).toBe('malformed');
    }
    expect((await load('initiatives:\n  readableRoots: /srv\n')).status).toBe('malformed');
    expect((await load('initiatives:\n  readableRoots: [1]\n')).status).toBe('malformed');
    expect((await load('initiatives:\n  enabled: yes-please\n')).status).toBe('malformed');
    expect((await load('initiatives: []\n')).status).toBe('malformed');
  });

  it('clamp mirrors budget.maxUsdPerSession', () => {
    const r = clampInitiativeBudgets(
      {
        settings: { dailyBudgetUsd: 0 },
        initiative: { usdPerDay: 5, usdPerExploration: 2 },
      },
      { maxUsdPerDayPerPersonality: 4 },
    );
    expect(r.usdPerDay).toBe(4);
    expect(r.usdPerExploration).toBe(2);
    expect(r.clamps).toEqual(['usd_per_day 5 → 4 (operator ceiling maxUsdPerDayPerPersonality)']);

    const none = clampInitiativeBudgets(
      { settings: { dailyBudgetUsd: 0 }, initiative: { usdPerDay: 5, usdPerExploration: 2 } },
      undefined,
    );
    expect(none).toEqual({ usdPerDay: 5, usdPerExploration: 2, clamps: [] });

    const personality = clampInitiativeBudgets(
      { settings: { dailyBudgetUsd: 3 }, initiative: { usdPerDay: 5, usdPerExploration: 2 } },
      { maxUsdPerDay: 10 },
    );
    expect(personality.usdPerDay).toBe(3);
    expect(personality.clamps).toEqual(['usd_per_day 5 → 3 (personality dailyBudgetUsd)']);
  });

  it('top-level unknown keys are still ignored', async () => {
    const r = await load('somethingNew: 1\ninitiatives:\n  maxSelfStarted: 1\n');
    expect(r).toEqual({
      status: 'loaded',
      constitution: { initiatives: { maxSelfStarted: 1 } },
    });
  });
});
