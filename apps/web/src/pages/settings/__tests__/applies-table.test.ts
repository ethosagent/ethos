// B6 (§6.4/§6.5) — the applies table's completeness gate. Every `formName`
// any pane renders (enumerated programmatically from `SETTINGS_INDEX`, which
// `settings-index-coverage.test.ts` already pins against the pane sources) has
// exactly one entry in `SETTING_APPLIES`, and the table carries no orphan a
// pane no longer renders. A default would make this trivially green, which is
// why there is none: adding a control forces a decision about when it applies.

import { describe, expect, it } from 'vitest';
import { SETTING_APPLIES } from '../lib/applies';
import { SETTINGS_INDEX } from '../lib/settings-index';

const indexFormNames = new Set(
  SETTINGS_INDEX.flatMap((entry) => (entry.formName ? [entry.formName] : [])),
);

describe('SETTING_APPLIES completeness', () => {
  it('has an entry for every formName any pane uses', () => {
    const missing = [...indexFormNames].filter((name) => !(name in SETTING_APPLIES));
    expect(missing).toEqual([]);
  });

  it('carries no entry for a formName no pane uses', () => {
    const orphans = Object.keys(SETTING_APPLIES).filter((name) => !indexFormNames.has(name));
    expect(orphans).toEqual([]);
  });

  it('every value is one of the three applies levels', () => {
    for (const value of Object.values(SETTING_APPLIES)) {
      expect(['live', 'next-turn', 'gateway-restart']).toContain(value);
    }
  });
});
