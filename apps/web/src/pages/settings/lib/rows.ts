// The repeatable-row shapes the page keeps in `useState` alongside the form
// store: the quick commands, the channel toolsets and the retention rules.
// Moved verbatim out of `Settings.tsx` (Phase 1); they live in `SettingsShell`
// and pass down to the panes as props, because they have no `preserve` to
// survive a pane unmount the way form fields do (D4).
//
// The provider chain used to be one of these. It saves on confirm now, through
// `modelRegistry.*` (Settings → Models › providers & models), so the page keeps
// no copy of it.

import { type ConfigGetData, RETENTION_SUBKEYS, type RetentionSubkey } from './config-types';
import { nextRowId } from './row-id';

export interface QuickCommandRow {
  _id: number;
  name: string;
  type: 'exec' | 'reply';
  command: string;
  reply: string;
  gateway: boolean;
  channels: string[];
}

export interface ChannelToolsetRow {
  _id: number;
  platform: string;
  toolsets: string[];
}

export interface RetentionRow {
  _id: number;
  /** '' = global `retention.<subkey>`; otherwise `personalities.<id>.retention.<subkey>`. */
  personalityId: string;
  subkey: RetentionSubkey;
  duration: string;
}

export function quickCommandRowsFromConfig(
  commands: ConfigGetData['quickCommands'],
): QuickCommandRow[] {
  return Object.entries(commands)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, qc]) => ({
      _id: nextRowId(),
      name,
      type: qc.type,
      command: qc.type === 'exec' ? qc.command : '',
      reply: qc.type === 'reply' ? qc.reply : '',
      gateway: qc.gateway,
      channels: qc.channels,
    }));
}

export function channelToolsetRowsFromConfig(
  map: ConfigGetData['channelToolsets'],
): ChannelToolsetRow[] {
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([platform, toolsets]) => ({ _id: nextRowId(), platform, toolsets }));
}

export function retentionRowsFromConfig(
  retention: ConfigGetData['retention'],
  personalityRetention: ConfigGetData['personalityRetention'],
): RetentionRow[] {
  const rows: RetentionRow[] = [];
  for (const subkey of RETENTION_SUBKEYS) {
    const duration = retention[subkey];
    if (duration !== undefined)
      rows.push({ _id: nextRowId(), personalityId: '', subkey, duration });
  }
  for (const [pid, map] of Object.entries(personalityRetention).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    for (const subkey of RETENTION_SUBKEYS) {
      const duration = map[subkey];
      if (duration !== undefined) {
        rows.push({ _id: nextRowId(), personalityId: pid, subkey, duration });
      }
    }
  }
  return rows;
}
