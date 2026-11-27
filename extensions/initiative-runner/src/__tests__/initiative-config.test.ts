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
sources: [sessions, kanban, repo, slack_read, memory, web]
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

  it('rejects an unknown source', () => {
    expect(InitiativeFileSchema.safeParse({ ...spec(), sources: ['shell'] }).success).toBe(false);
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

  it('unknown key fails at every level', () => {
    expect(InitiativeSettingsSchema.safeParse({ allowWrites: true }).success).toBe(false);
    expect(
      InitiativeSettingsSchema.safeParse({ defaultAutonomy: { mode: 'ask', x: 1 } }).success,
    ).toBe(false);
    expect(
      InitiativeSettingsSchema.safeParse({
        delivery: { ownerChannel: 'a', digestTime: 'b', x: 1 },
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
