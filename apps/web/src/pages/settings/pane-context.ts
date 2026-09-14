// What `SettingsShell` hands its panes through the `<Outlet/>`.
//
// Everything stateful is in this object because nothing stateful may be in a
// pane: panes mount and unmount as you navigate, and the form store plus the
// row arrays have to outlive that (plan/phases/settings-navigation.md §5,
// D1 and D4). A pane reads and writes through these handles; it never owns them.
//
// The provider chain is NOT here: providers save on confirm through
// `modelRegistry.*` (Settings → Models › providers & models) and are read from
// `modelRegistry.list`, so the page holds no copy of them to go stale.

import type { FormInstance } from 'antd';
import type { Dispatch, SetStateAction } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { rpc } from '../../rpc';
import type { ConfigGetData } from './lib/config-types';
import type { FormShape } from './lib/form-shape';
import type { ChannelToolsetRow, QuickCommandRow, RetentionRow } from './lib/rows';
import type { VoiceBotRow } from './lib/voice-bots';
import type { VoiceProviderRow } from './lib/voice-roster';

/** One entry of `personalities.list` — carries `builtin` alongside id/name. */
export type PersonalityListItem = Awaited<
  ReturnType<typeof rpc.personalities.list>
>['items'][number];

export interface SettingsPaneContext {
  /** The ONE form instance, created in the shell above the outlet. */
  form: FormInstance<FormShape>;
  /** What `config.get` last returned. Undefined only before the first payload. */
  config: ConfigGetData | undefined;
  personalities: PersonalityListItem[];
  personalitiesLoading: boolean;

  quickCommandRows: QuickCommandRow[];
  setQuickCommandRows: Dispatch<SetStateAction<QuickCommandRow[]>>;
  channelToolsetRows: ChannelToolsetRow[];
  setChannelToolsetRows: Dispatch<SetStateAction<ChannelToolsetRow[]>>;
  voiceTtsProviderRows: VoiceProviderRow[];
  setVoiceTtsProviderRows: Dispatch<SetStateAction<VoiceProviderRow[]>>;
  voiceSttProviderRows: VoiceProviderRow[];
  setVoiceSttProviderRows: Dispatch<SetStateAction<VoiceProviderRow[]>>;
  voiceRealtimeProviderRows: VoiceProviderRow[];
  setVoiceRealtimeProviderRows: Dispatch<SetStateAction<VoiceProviderRow[]>>;
  retentionRows: RetentionRow[];
  setRetentionRows: Dispatch<SetStateAction<RetentionRow[]>>;
  voiceBotRows: VoiceBotRow[];
  setVoiceBotRows: Dispatch<SetStateAction<VoiceBotRow[]>>;
}

export function useSettingsPane(): SettingsPaneContext {
  return useOutletContext<SettingsPaneContext>();
}
