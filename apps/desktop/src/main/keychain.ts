import { safeStorage } from 'electron';
import Store from 'electron-store';

// safeStorage uses the OS keychain (macOS Keychain, Windows DPAPI, Linux libsecret)
// to encrypt values. The encrypted buffer is stored in a dedicated keychain.json
// (separate from config.json) as base64.
// No native module required — safeStorage is built into Electron 15+.

const keychainStore = new Store<Record<string, string>>({ name: 'keychain' });

export async function setKeychainValue(key: string, value: string): Promise<void> {
  const encrypted = safeStorage.encryptString(value);
  keychainStore.set(key, encrypted.toString('base64'));
}

export async function getKeychainValue(key: string): Promise<string | null> {
  const encoded = keychainStore.get(key) as string | undefined;
  if (!encoded) return null;
  return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
}

export async function deleteKeychainValue(key: string): Promise<void> {
  keychainStore.delete(key as never);
}
