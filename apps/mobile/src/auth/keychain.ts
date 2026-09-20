import {
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  deleteItemAsync,
  getItemAsync,
  setItemAsync,
} from 'expo-secure-store';

// `src/auth` is the only place the Keychain is read (D2: the key never touches
// AsyncStorage). AFTER_FIRST_UNLOCK so the push extension can read it on a
// locked phone; _THIS_DEVICE_ONLY keeps it out of backups (R9f). No
// requireAuthentication — the extension cannot prompt.
const OPTS = { keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const URL_ITEM = 'ethos.server-url';
const KEY_ITEM = 'ethos.api-key';

export async function loadConnection(): Promise<{ url: string | null; key: string | null }> {
  const [url, key] = await Promise.all([
    getItemAsync(URL_ITEM, OPTS),
    getItemAsync(KEY_ITEM, OPTS),
  ]);
  return { url, key };
}

export async function saveConnection(url: string, key: string): Promise<void> {
  await setItemAsync(URL_ITEM, url, OPTS);
  await setItemAsync(KEY_ITEM, key, OPTS);
}

/** Disconnect / a revoked key: forget the key, keep the URL for the next Connect. */
export async function clearKey(): Promise<void> {
  await deleteItemAsync(KEY_ITEM, OPTS);
}
