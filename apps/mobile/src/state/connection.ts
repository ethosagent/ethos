import type { EthosClient } from '@ethosagent/sdk';
import { create } from 'zustand';
import { makeClient, streams } from '../api/client';
import { clearKey, saveConnection } from '../auth/keychain';

interface ConnectionStore {
  /** False until the Keychain has been read at launch (the splash holds). */
  loaded: boolean;
  url: string | null;
  key: string | null;
  client: EthosClient | null;
  /** The last `/healthz` probe answered. Sends are refused, never queued, while false. */
  online: boolean;
  /** Connect succeeded and the first-run screens (agent pick, notify) are not done. */
  onboarding: boolean;
  /** The agent picked on first run — the first New session uses it. */
  personalityId: string | null;
  /** A scanned `ethos://connect` link, handed to the Connect form in memory only. */
  draft: { url: string; key: string } | null;
  set(patch: Partial<ConnectionStore>): void;
  /** Launch: adopt what the Keychain held. */
  restore(url: string | null, key: string | null): void;
  connect(url: string, key: string): Promise<void>;
  /** Forget the key (Disconnect, or UNAUTHORIZED) and return to Connect with the URL kept. */
  disconnect(): Promise<void>;
}

export const useConnection = create<ConnectionStore>((set) => ({
  loaded: false,
  url: null,
  key: null,
  client: null,
  online: true,
  onboarding: false,
  personalityId: null,
  draft: null,
  set: (patch) => set(patch),
  restore: (url, key) =>
    set({ loaded: true, url, key, client: url && key ? makeClient(url, key) : null }),
  async connect(url, key) {
    await saveConnection(url, key);
    set({ url, key, client: makeClient(url, key), onboarding: true, online: true });
  },
  async disconnect() {
    streams.closeAll();
    await clearKey();
    set({ key: null, client: null });
  },
}));
