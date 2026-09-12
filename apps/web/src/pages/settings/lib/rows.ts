// The repeatable-row shapes the page keeps in `useState` alongside the form
// store: the provider chain, the quick commands, the channel toolsets and the
// retention rules. Moved verbatim out of `Settings.tsx` (Phase 1); they live in
// `SettingsShell` and pass down to the panes as props, because they have no
// `preserve` to survive a pane unmount the way form fields do (D4).

import type { ProviderEntry } from '@ethosagent/web-contracts';
import { type ConfigGetData, RETENTION_SUBKEYS, type RetentionSubkey } from './config-types';
import { nextRowId } from './row-id';

// ---------------------------------------------------------------------------
// Provider chain row — local state for the editor
// ---------------------------------------------------------------------------

export interface ProviderRow {
  /** Stable key for React list rendering. */
  _id: number;
  provider: string;
  model: string;
  apiKey: string;
  apiKeyPreview: string;
  baseUrl: string;
  testStatus: 'idle' | 'testing' | 'success' | 'error';
  testError?: string;
  /** Position in `config.get`'s `providers` this row was loaded from. Sent
   *  back on save so the server keeps the stored entry's key reference and the
   *  fields this editor does not show (`region`, `apiVersion`, …). Absent for a
   *  row added here, and for the legacy single-provider row. */
  sourceIndex?: number;
}

/**
 * What the provider rows were loaded from: `config.get`'s `providersVersion`
 * (sent back on save, so a chain changed elsewhere is refused rather than
 * overwritten) and the primary row as loaded (a save writes the top-level
 * provider fields only when the operator edited it).
 */
export interface ProviderChainBase {
  providersVersion: string;
  loadedPrimary?: ProviderRow;
}

/**
 * Whether the page must rebuild its rows from a `config.get` response: on the
 * first load, after a save or a refused save (`hydrated` reset), and whenever
 * the stored chain is no longer the one the rows were built from — keyed on
 * `providersVersion`, not on the response object, because a save that swaps
 * two same-looking entries returns a response React Query sees as unchanged
 * while the rows' `sourceIndex` values now point at the other entry.
 */
export function shouldRebuildRows(
  hydrated: boolean,
  rowsVersion: string | undefined,
  dataVersion: string,
): boolean {
  return !hydrated || rowsVersion !== dataVersion;
}

export function emptyRow(): ProviderRow {
  return {
    _id: nextRowId(),
    provider: '',
    model: '',
    apiKey: '',
    apiKeyPreview: '',
    baseUrl: '',
    testStatus: 'idle',
  };
}

export function rowsFromConfig(
  providers: ProviderEntry[],
  legacyProvider?: string,
  legacyModel?: string,
  legacyApiKeyPreview?: string,
  legacyBaseUrl?: string | null,
): ProviderRow[] {
  if (providers.length > 0) {
    return providers.map((p, i) => ({
      _id: nextRowId(),
      provider: p.provider,
      model: p.model ?? '',
      apiKey: '',
      apiKeyPreview: p.apiKeyPreview,
      baseUrl: p.baseUrl ?? '',
      testStatus: 'idle' as const,
      sourceIndex: i,
    }));
  }
  // Backward compat: populate from single-field config
  if (legacyProvider) {
    return [
      {
        _id: nextRowId(),
        provider: legacyProvider,
        model: legacyModel ?? '',
        apiKey: '',
        apiKeyPreview: legacyApiKeyPreview ?? '',
        baseUrl: legacyBaseUrl ?? '',
        testStatus: 'idle' as const,
      },
    ];
  }
  return [emptyRow()];
}

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
