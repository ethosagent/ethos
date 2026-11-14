// Opt-in system notification toggle (ux-2 attention signals). A plain antd
// `Switch` outside any `Form.Item`: the preference lives in this browser's
// localStorage (lib/attention/notify.ts), so `buildConfigPatch` and the page
// Save bar never see it. `Notification.requestPermission()` runs only from
// the click handler below (user gesture).

import { Switch } from 'antd';
import { useState } from 'react';
import {
  enableAttentionNotifications,
  getAttentionNotifyPref,
  type NotifySupport,
  notificationSupport,
  setAttentionNotifyPref,
} from '../../../lib/attention/notify';
import { SelfSaveMarker } from '../components/self-save-marker';
import { SettingRow } from '../components/setting-row';

const ENABLE_HELP =
  'Show a system notification when a chat needs you and this tab is in the background. Stored in this browser only.';

const SAVE_ERROR =
  'Could not save this setting (browser storage is full or blocked). It is shown as currently stored.';

const HELP: Record<NotifySupport, string> = {
  granted: ENABLE_HELP,
  default: ENABLE_HELP,
  denied:
    "Blocked in your browser's site settings; allow notifications for this site, then switch this on.",
  unsupported: 'This browser does not support notifications.',
};

export function AttentionNotifyRow() {
  const [support, setSupport] = useState<NotifySupport>(() => notificationSupport());
  const [on, setOn] = useState<boolean>(
    () => notificationSupport() === 'granted' && getAttentionNotifyPref(),
  );

  const [saveError, setSaveError] = useState(false);

  async function onChange(next: boolean) {
    setSaveError(false);
    if (!next) {
      const wrote = setAttentionNotifyPref(false);
      // The Switch shows what is actually stored, not what was asked for.
      const stored = getAttentionNotifyPref();
      setOn(stored);
      if (!wrote || stored) setSaveError(true);
      return;
    }
    const result = await enableAttentionNotifications();
    setSupport(notificationSupport());
    // On only when permission was granted AND the preference really stored.
    const stored = result === 'granted' && getAttentionNotifyPref();
    setOn(stored);
    if (result === 'granted' && !stored) setSaveError(true);
  }

  return (
    <SettingRow label="Browser notifications" help={saveError ? SAVE_ERROR : HELP[support]}>
      <SelfSaveMarker />
      <Switch checked={on} disabled={support === 'unsupported'} onChange={onChange} />
    </SettingRow>
  );
}
