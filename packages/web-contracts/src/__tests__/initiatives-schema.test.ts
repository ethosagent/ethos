import { describe, expect, it } from 'vitest';
import { contract } from '../router';
import {
  CONSTITUTION_INITIATIVES_FIELD_KEYS,
  ConstitutionInitiativesSaveInputSchema,
  INITIATIVE_FILE_FIELD_KEYS,
  INITIATIVE_SETTINGS_FIELD_KEYS,
  InitiativeDecideInputSchema,
  InitiativeFileWireSchema,
  InitiativeSettingsWireSchema,
  InitiativesSettingsSaveInputSchema,
} from '../schemas';

const settings = {
  enabled: true,
  selfStart: false,
  dailyBudgetUsd: 3,
  defaultAutonomy: { mode: 'free_under', askAboveUsd: 1 },
  delivery: { ownerChannel: 'telegram', digestTime: '08:00' },
  standingGuidance: [],
};
const block = {
  enabled: true,
  maxUsdPerDay: 10,
  maxUsdPerDayPerPersonality: 4,
  selfStartPoolUsdPerDay: 0.5,
  maxSelfStarted: 2,
  readableRoots: ['~/code', '~/notes/product'],
};

describe('initiatives contract', () => {
  it('mounts the plan routes', () => {
    expect(Object.keys(contract.initiatives).sort()).toEqual([
      'activity',
      'decide',
      'exploringNow',
      'get',
      'list',
      'metrics',
      'settings',
      'settingsSave',
    ]);
    expect(Object.keys(contract.constitution).sort()).toEqual(['initiatives', 'initiativesSave']);
  });

  it('settingsSave example parses; unknown key allowWrites fails at every level', () => {
    const body = { personalityId: 'product-manager', settings };
    expect(InitiativesSettingsSaveInputSchema.safeParse(body).success).toBe(true);
    expect(
      InitiativesSettingsSaveInputSchema.safeParse({
        ...body,
        settings: { ...settings, allowWrites: true },
      }).success,
    ).toBe(false);
    expect(
      InitiativeSettingsWireSchema.safeParse({
        ...settings,
        delivery: { ...settings.delivery, allowWrites: true },
      }).success,
    ).toBe(false);
  });

  it('constitution save example parses; unknown key and ~/.ssh fail', () => {
    expect(ConstitutionInitiativesSaveInputSchema.safeParse({ initiatives: block }).success).toBe(
      true,
    );
    expect(
      ConstitutionInitiativesSaveInputSchema.safeParse({
        initiatives: { ...block, allowWrites: true },
      }).success,
    ).toBe(false);
  });

  it.each([
    '~/.ssh',
    '~/.ssh/keys',
    '~/code/../.ssh',
    '/Users/me/.ssh',
    '$HOME/.ssh',
    '/home/me/.ssh/',
  ])('readableRoots refuses %s', (root) => {
    const r = ConstitutionInitiativesSaveInputSchema.safeParse({
      initiatives: { readableRoots: [root] },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('readableRoots refuses ~/.ssh');
  });

  it('decide: plan example parses, all three gates, wrong verdict for gate fails', () => {
    const ok = (v: unknown) => InitiativeDecideInputSchema.safeParse(v).success;
    expect(ok({ target: 'EXP-0007', gate: 'gate2_adopt', verdict: 'adopt', option: 'B' })).toBe(
      true,
    );
    expect(ok({ target: 'P-1', gate: 'gate1_explore', verdict: 'approve' })).toBe(true);
    expect(ok({ target: 'INI-1', gate: 'self_start', verdict: 'make_mine' })).toBe(true);
    expect(ok({ target: 'INI-1', gate: 'self_start', verdict: 'adopt' })).toBe(false);
    expect(ok({ target: 'EXP-1', gate: 'gate2_adopt', verdict: 'adopt', allowWrites: 1 })).toBe(
      false,
    );
  });

  it('exploringNow readOnly is the literal true', () => {
    const out = contract.initiatives.exploringNow['~orpc'].outputSchema;
    const row = {
      windowId: 'w',
      initiativeId: 'i',
      initiativeTitle: 't',
      explorationId: null,
      question: null,
      started: '2026-01-01T00:00:00Z',
      costSoFarUsd: 0.1,
    };
    const v = (current: unknown) => out?.['~standard'].validate({ current });
    expect(v(null)).not.toHaveProperty('issues');
    expect(v({ ...row, readOnly: true })).not.toHaveProperty('issues');
    expect(v({ ...row, readOnly: false })).toHaveProperty('issues');
  });

  it('initiative file schema is strict', () => {
    expect(InitiativeFileWireSchema.safeParse({ id: 'x', allowWrites: true }).success).toBe(false);
  });
});

describe('field key lists', () => {
  it('settings keys match Config surfaces', () => {
    expect(INITIATIVE_SETTINGS_FIELD_KEYS).toEqual([
      'enabled',
      'selfStart',
      'dailyBudgetUsd',
      'defaultAutonomy.mode',
      'defaultAutonomy.askAboveUsd',
      'delivery.ownerChannel',
      'delivery.digestTime',
      'standingGuidance',
    ]);
  });

  it('constitution initiatives keys match Config surfaces', () => {
    expect(CONSTITUTION_INITIATIVES_FIELD_KEYS).toEqual([
      'enabled',
      'maxUsdPerDay',
      'maxUsdPerDayPerPersonality',
      'selfStartPoolUsdPerDay',
      'maxSelfStarted',
      'readableRoots',
    ]);
  });

  it('initiative file keys are the 24 labeled rows', () => {
    expect(INITIATIVE_FILE_FIELD_KEYS).toEqual([
      'id',
      'version',
      'origin',
      'created_in',
      'state',
      'title',
      'outcome',
      'sources',
      'exclude',
      'guidance',
      'autonomy.mode',
      'autonomy.ask_above_usd',
      'budget.usd_per_day',
      'budget.usd_per_exploration',
      'budget.max_open_explorations',
      'timeline.explore_windows',
      'timeline.window_minutes',
      'timeline.default_days',
      'timeline.review_on',
      'timeline.ends_on',
      'delivery.owner_channel',
      'delivery.digest_time',
      'parent_id',
      'notes',
    ]);
  });
});
