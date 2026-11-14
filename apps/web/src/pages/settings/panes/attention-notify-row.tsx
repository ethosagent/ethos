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

  async function onChange(next: boolean) {
    if (!next) {
      setAttentionNotifyPref(false);
      setOn(false);
      return;
    }
    const result = await enableAttentionNotifications();
    setSupport(notificationSupport());
    // Switch reflects the resolved outcome: on only when permission was granted.
    setOn(result === 'granted');
  }

  return (
    <SettingRow label="Browser notifications" help={HELP[support]}>
      <SelfSaveMarker />
      <Switch checked={on} disabled={support === 'unsupported'} onChange={onChange} />
    </SettingRow>
  );
}
