import type { EthosClient } from '@ethosagent/sdk';
import type { PushCategories } from '@ethosagent/web-contracts';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { registerPushCategories } from './categories';

// Push registration (S5, T4): permission request, Expo push token, and
// `push.register` with the device's category booleans. `src/push` holds the
// only Expo push token this process obtains; it is cached in-memory (never
// AsyncStorage — D2's Keychain rule is for the server key, not this) so
// Disconnect can unregister it without re-deriving it.

/** D11's defaults: everything but `runFinished`, which is opt-in. */
export const DEFAULT_PUSH_CATEGORIES: PushCategories = {
  approvals: true,
  clarify: true,
  cronFailures: true,
  teamAttention: true,
  runFinished: false,
};

let cachedToken: string | null = null;

export function getCachedPushToken(): string | null {
  return cachedToken;
}

async function createAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  // Android 13+ shows no permission prompt without a channel first (R17).
  await Notifications.setNotificationChannelAsync('default', {
    name: 'Ethos',
    importance: Notifications.AndroidImportance.HIGH,
  });
}

export type RegisterResult =
  | { registered: true; expoPushToken: string }
  | { registered: false; reason: 'permission-denied' | string };

/** ob-notify and the Settings toggles (T4). Categories are (re-)registered on
 *  every call so an app update always has the current set; the Android
 *  channel is created before the permission prompt (R17). The Expo project id
 *  (`extra.eas.projectId`) is not wired into `app.config.ts` yet — T-DIST's
 *  EAS project is a prerequisite this build does not have — so
 *  `getExpoPushTokenAsync` is called without one until then. */
export async function registerForPush(
  rpc: EthosClient['rpc'],
  categories: PushCategories = DEFAULT_PUSH_CATEGORIES,
): Promise<RegisterResult> {
  // The free-provisioning build (`APP_VARIANT=sideload`) has no
  // `aps-environment` entitlement, so APNs would refuse the token anyway.
  if (Constants.expoConfig?.extra?.variant === 'sideload') {
    return { registered: false, reason: 'push needs the paid Apple program (sideload build)' };
  }
  await createAndroidChannel();
  await registerPushCategories();
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return { registered: false, reason: 'permission-denied' };
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  const { data: expoPushToken } = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  );
  cachedToken = expoPushToken;
  try {
    await rpc.push.register({
      expoPushToken,
      platform: Platform.OS === 'android' ? 'android' : 'ios',
      categories,
      liveActivities: false,
      appVersion: Constants.expoConfig?.version ?? '0.0.0',
    });
  } catch (err) {
    cachedToken = null;
    return { registered: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return { registered: true, expoPushToken };
}

/** Disconnect (S5): forget this device server-side before the key it was
 *  registered under stops working. Best-effort — a failed unregister is not
 *  worth blocking Disconnect over; the revoked-key join and the retention
 *  sweep clean up the row regardless. */
export async function unregisterCurrentPush(rpc: EthosClient['rpc'] | undefined): Promise<void> {
  if (!rpc || !cachedToken) return;
  const token = cachedToken;
  cachedToken = null;
  await rpc.push.unregister({ expoPushToken: token }).catch(() => undefined);
}
