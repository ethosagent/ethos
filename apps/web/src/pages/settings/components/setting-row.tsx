// SettingRow — the `Card` + `Form.Item` replacement (plan §6.2). Label (14px /
// 500) · config key (Geist Mono 13px, `--text-tertiary`) · help text (12px,
// `--text-secondary`) · callout · control, right-aligned, with a 1px
// `--border-subtle` hairline below. Not a `Card` (DESIGN.md "Cards earn
// existence").
//
// The config key line is resolved from `SETTINGS_INDEX` by `formName` (D8) — a
// pane never hand-types a key string, so the row and the search index cannot
// drift apart. Two entries carry `derived: true` instead of a key (§7: `Voice
// enabled`, `Restrict voice egress`) — the row renders the literal word
// `derived` in the key line's position rather than a plausible-looking key
// that does not exist. `status` (`unread` / `broken`) resolves the same way
// and renders a `StatusCallout` after the help text (Phase 7).
//
// State-backed widgets that have no `Form.Item` (rosters, tables, read-only
// views) do not use this component; §6.3 gives them their own shape, in
// Phase 6.
//
// `advanced` reuses Phase 2's dim treatment (`components/advanced.tsx`)
// verbatim, rather than inventing a second one — a control you can see and
// cannot touch is a trap, so dimming is opacity only and the control stays
// interactive (D10).

import type { ReactNode } from 'react';
import { appliesForFormName, type SettingApplies } from '../lib/applies';
import { isDerivedFormName, keyForFormName, statusForFormName } from '../lib/settings-index';
import { AdvancedBlock } from './advanced';
import { StatusCallout } from './status-callout';

/** Glyph + word per applies value (§6.5) — never colour alone. */
const APPLIES_BADGE: Record<SettingApplies, { glyph: string; word: string }> = {
  live: { glyph: '·', word: 'live' },
  'next-turn': { glyph: '⏳', word: 'next turn' },
  'gateway-restart': { glyph: '⚠', word: 'gateway restart' },
};

export function SettingRow({
  label,
  formName,
  help,
  advanced,
  applies,
  children,
}: {
  label: string;
  /** Dotted `Form.Item` name as it appears in `SETTINGS_INDEX` — resolves the key line. */
  formName?: string | null;
  help?: string;
  advanced?: boolean;
  /**
   * When a save of this row takes effect (B6/§6.5). Defaults to the per-key
   * table in `lib/applies.ts`, resolved by `formName` — pass explicitly only
   * for a row the index does not name.
   */
  applies?: SettingApplies;
  children: ReactNode;
}) {
  const derived = formName ? isDerivedFormName(formName) : false;
  const configKey = formName ? keyForFormName(formName) : null;
  const status = formName ? statusForFormName(formName) : null;
  const appliesValue = applies ?? (formName ? appliesForFormName(formName) : null);
  const badge = appliesValue ? APPLIES_BADGE[appliesValue] : null;
  const row = (
    <div className="settings-row">
      <div className="settings-row-info">
        <div className="settings-row-label">{label}</div>
        {derived ? (
          <div className="settings-row-key">derived</div>
        ) : configKey ? (
          <div className="settings-row-key">{configKey}</div>
        ) : null}
        {badge ? (
          <div
            className={`settings-row-applies settings-row-applies-${appliesValue}`}
            title={`Applies: ${badge.word}`}
          >
            <span aria-hidden="true">{badge.glyph}</span> {badge.word}
          </div>
        ) : null}
        {help ? <div className="settings-row-help">{help}</div> : null}
        {status ? <StatusCallout kind={status} /> : null}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
  return advanced ? <AdvancedBlock>{row}</AdvancedBlock> : row;
}
