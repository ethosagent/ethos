// Settings → Automation → Initiatives rows for `SETTINGS_INDEX`, kept beside it
// rather than in it (`settings-index.ts` is at its size baseline). One row per
// control in `panes/automation-initiatives.tsx`. Not `config.yaml` keys: the
// constitution `initiatives` block, written through `rpc.constitution.initiativesSave`,
// so every row saves on its own and has no `Form.Item` name.

import type { SettingEntry } from './settings-index';

function row(key: string, label: string): SettingEntry {
  return {
    key: `constitution.initiatives.${key}`,
    formName: null,
    label,
    category: 'automation',
    section: 'initiatives',
    advanced: false,
    saves: 'self',
    status: null,
    stateBacked: true,
  };
}

export const INITIATIVES_SETTINGS_ENTRIES: readonly SettingEntry[] = [
  row('enabled', 'Initiatives enabled'),
  row('maxUsdPerDay', 'Daily spend, all personalities (USD)'),
  row('maxUsdPerDayPerPersonality', 'Daily spend per personality (USD)'),
  row('selfStartPoolUsdPerDay', 'Self-start pool per day (USD)'),
  row('maxSelfStarted', 'Agent-started initiatives allowed'),
  row('readableRoots', 'Readable folders'),
];
