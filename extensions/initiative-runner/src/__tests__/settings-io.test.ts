import { describe, expect, it } from 'vitest';
import {
  clampInitiativeSettings,
  renderConstitutionWithInitiatives,
  validateConstitutionInitiatives,
  validateInitiativeSettings,
} from '../settings-io';

const BASE = `# top comment
budget:
  maxUsdPerSession: 5   # spaced comment

forbidden:
  tools: [terminal]
`;

describe('settings-io', () => {
  it('appends the block, leaving every other byte alone', () => {
    const r = renderConstitutionWithInitiatives(BASE, { enabled: false });
    expect(r).toEqual({ ok: true, text: `${BASE}initiatives:\n  enabled: false\n` });
  });
  it('replaces only an existing block, with a following block untouched', () => {
    const raw = `${BASE}initiatives:\n  enabled: true\n  # old note\n  maxUsdPerDay: 9\n\nnetwork:  # tail\n  x: 1\n`;
    const r = renderConstitutionWithInitiatives(raw, { maxUsdPerDay: 2 });
    expect(r).toEqual({
      ok: true,
      text: `${BASE}initiatives:\n  maxUsdPerDay: 2\n\nnetwork:  # tail\n  x: 1\n`,
    });
  });
  it('creates the file text when there was none, and refuses malformed yaml', () => {
    expect(renderConstitutionWithInitiatives(null, { enabled: true })).toEqual({
      ok: true,
      text: 'initiatives:\n  enabled: true\n',
    });
    expect(renderConstitutionWithInitiatives('a: [unclosed\n', {}).ok).toBe(false);
  });
  it('refuses blocked readableRoots', () => {
    expect(validateConstitutionInitiatives({ readableRoots: ['~/.ssh'] }, '/tmp/x').ok).toBe(false);
    expect(validateConstitutionInitiatives({ readableRoots: ['~'] }, '/tmp/x').ok).toBe(false);
    expect(validateConstitutionInitiatives({ readableRoots: ['~/code'] }, '/tmp/x').ok).toBe(true);
    expect(validateConstitutionInitiatives({ nope: 1 }, '/tmp/x').ok).toBe(false);
  });
  it('clamps to the smaller ceiling and leaves 0 (unset) alone', () => {
    const s = validateInitiativeSettings({ dailyBudgetUsd: 5 });
    if (!s.ok) throw new Error(s.error);
    expect(
      clampInitiativeSettings(s.settings, { maxUsdPerDay: 8, maxUsdPerDayPerPersonality: 4 })
        .clamps,
    ).toEqual(['dailyBudgetUsd 5 → 4 (operator ceiling)']);
    expect(
      clampInitiativeSettings({ ...s.settings, dailyBudgetUsd: 0 }, { maxUsdPerDay: 1 }).clamps,
    ).toEqual([]);
    expect(validateInitiativeSettings({ allowWrites: true }).ok).toBe(false);
  });
});
