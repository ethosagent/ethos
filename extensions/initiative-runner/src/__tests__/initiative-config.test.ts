import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  INITIATIVE_FILE_KEYS,
  INITIATIVE_SETTINGS_KEYS,
  InitiativeFileSchema,
  InitiativeSettingsSchema,
} from '../index';

const SPEC_YAML = `
id: self-serve-activation
version: 3
origin: human
created_in: session-abc123
state: active
title: Self-serve activation
outcome: Raise the share of new signups reaching first value in 24h
sources: [sessions, kanban, { repo: ~/code/app }, slack_read, memory, web]
exclude:
  - enterprise accounts
guidance:
  - text: check LinkedIn for how competitors pitch onboarding
    maps_to: [linkedin_search]
    status: mapped
  - text: look at G2 reviews
autonomy:
  mode: free_under
  ask_above_usd: 1
budget:
  usd_per_day: 3
  usd_per_exploration: 2
  max_open_explorations: 3
timeline:
  explore_windows: ["0 9 * * 1-5", "every 6h"]
  window_minutes: 20
  default_days: 14
  review_on: "2026-12-15"
delivery:
  owner_channel: slack:C123
  digest_time: "08:30"
`;

const spec = () => parse(SPEC_YAML) as Record<string, unknown>;

describe('initiative file schema', () => {
  it('spec example parses', () => {
    const r = InitiativeFileSchema.safeParse(spec());
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.autonomy.mode).toBe('free_under');
  });

  it('unknown key fails at top level and inside every nested block', () => {
    for (const bad of [{ allowWrites: true }, { execute: 'rm -rf /' }, { tools: ['bash'] }]) {
      expect(InitiativeFileSchema.safeParse({ ...spec(), ...bad }).success).toBe(false);
    }
    for (const block of ['budget', 'autonomy', 'timeline', 'delivery'] as const) {
      const doc = spec();
      doc[block] = { ...(doc[block] as object), allowWrites: true };
      expect(InitiativeFileSchema.safeParse(doc).success).toBe(false);
    }
    const doc = spec();
    doc.budget = { ...(doc.budget as object), tools: ['bash'] };
    expect(InitiativeFileSchema.safeParse(doc).success).toBe(false);
    const g = spec();
    g.guidance = [{ text: 'x', execute: true }];
    expect(InitiativeFileSchema.safeParse(g).success).toBe(false);
  });

  it('one-shot explore_windows (relative, ISO) are refused; cron and "every N" pass', () => {
    const ok = (w: string) => {
      const doc = parse(SPEC_YAML) as Record<string, unknown>;
      doc.timeline = { ...(doc.timeline as object), explore_windows: [w] };
      return InitiativeFileSchema.safeParse(doc).success;
    };
    expect(ok('in 5m')).toBe(false);
    expect(ok('30m')).toBe(false);
    expect(ok('2026-12-01T09:00:00Z')).toBe(false);
    expect(ok('every 15m')).toBe(true);
    expect(ok('0 9 * * 1-5')).toBe(true);
  });

  it('bad cron in explore_windows fails with the field path', () => {
    const doc = spec();
    doc.timeline = { ...(doc.timeline as object), explore_windows: ['0 9 * * 1-5', 'not a cron'] };
    const r = InitiativeFileSchema.safeParse(doc);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('timeline.explore_windows.1');
    }
  });

  it('parent_id and notes are agent origin only', () => {
    const human = { ...spec(), parent_id: 'p1' };
    expect(InitiativeFileSchema.safeParse(human).success).toBe(false);
    const humanNotes = { ...spec(), notes: ['a'] };
    expect(InitiativeFileSchema.safeParse(humanNotes).success).toBe(false);
    const agent = { ...spec(), origin: 'agent', parent_id: 'p1', notes: ['approach'] };
    expect(InitiativeFileSchema.safeParse(agent).success).toBe(true);
  });

  it('rejects an unknown source, a bare repo, a repo without a path and extra keys', () => {
    for (const bad of ['shell', 'repo', { repo: '' }, {}, { repo: '/a', web: 1 }, { web: '/a' }]) {
      expect(InitiativeFileSchema.safeParse({ ...spec(), sources: [bad] }).success).toBe(false);
    }
  });

  it('exports one key list covering every top-level key', () => {
    expect([...INITIATIVE_FILE_KEYS]).toEqual(
      expect.arrayContaining(['id', 'timeline', 'parent_id', 'notes', 'delivery']),
    );
  });
});

describe('initiative settings schema', () => {
  it('missing settings.yaml is the defaults', () => {
    const r = InitiativeSettingsSchema.parse({});
    expect(r).toEqual({ enabled: true, selfStart: false, dailyBudgetUsd: 0, standingGuidance: [] });
  });

  it('accepts camelCase autonomy and delivery with both subfields', () => {
    const r = InitiativeSettingsSchema.safeParse({
      defaultAutonomy: { mode: 'free_under', askAboveUsd: 1 },
      delivery: { ownerChannel: 'slack:C1', digestTime: '08:00' },
      standingGuidance: ['check LinkedIn'],
    });
    expect(r.success).toBe(true);
  });

  it('delivery needs <platform>:<chatId> and HH:MM', () => {
    const d = (ownerChannel: string, digestTime: string) =>
      InitiativeSettingsSchema.safeParse({ delivery: { ownerChannel, digestTime } }).success;
    expect(d('telegram:12345', '08:00')).toBe(true);
    expect(d('telegram:12345', '8:05')).toBe(true);
    expect(d('telegram', '08:00')).toBe(false);
    expect(d('telegram:', '08:00')).toBe(false);
    expect(d(':1', '08:00')).toBe(false);
    expect(d('telegram:1', 'b')).toBe(false);
    expect(d('telegram:1', '24:00')).toBe(false);
    expect(d('telegram:1', '08:60')).toBe(false);
  });

  it('unknown key fails at every level', () => {
    expect(InitiativeSettingsSchema.safeParse({ allowWrites: true }).success).toBe(false);
    expect(
      InitiativeSettingsSchema.safeParse({ defaultAutonomy: { mode: 'ask', x: 1 } }).success,
    ).toBe(false);
    expect(
      InitiativeSettingsSchema.safeParse({
        delivery: { ownerChannel: 'a:1', digestTime: '08:00', x: 1 },
      }).success,
    ).toBe(false);
  });

  it('exports the settings key list', () => {
    expect([...INITIATIVE_SETTINGS_KEYS].sort()).toEqual(
      [
        'dailyBudgetUsd',
        'defaultAutonomy',
        'delivery',
        'enabled',
        'selfStart',
        'standingGuidance',
      ].sort(),
    );
  });
});
