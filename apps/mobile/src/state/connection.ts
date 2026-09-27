import type { EthosClient } from '@ethosagent/sdk';
import { create } from 'zustand';
import { makeClient, streams } from '../api/client';
import { errorRow } from '../api/errors';
import { clearKey, loadConnection, saveConnection } from '../auth/keychain';
import type { RowData } from '../lib/row';

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
  /** Launch (`app/_layout.tsx`, fired and forgotten): read the Keychain and
   *  `restore` it. Never rejects — an unreadable Keychain lands on Connect. */
  hydrate(): Promise<void>;
  /** Save and adopt. Never rejects: a Keychain write that fails is the row
   *  it returns (null on success), and the connection is not adopted. */
  connect(url: string, key: string): Promise<RowData | null>;
  /** Forget the key (Disconnect, or UNAUTHORIZED) and return to Connect with
   *  the URL kept. Never rejects — both callers fire and forget it. */
  disconnect(): Promise<void>;
}

export const useConnection = create<ConnectionStore>((set, get) => ({
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
  async hydrate() {
    let saved: { url: string | null; key: string | null } = { url: null, key: null };
    try {
      saved = await loadConnection();
    } catch {
      // Nothing readable is nothing saved: Connect, not a crash at launch.
    }
    get().restore(saved.url, saved.key);
  },
  async connect(url, key) {
    try {
      await saveConnection(url, key);
    } catch (err) {
      return errorRow(err, 'keychain');
    }
    set({ url, key, client: makeClient(url, key), onboarding: true, online: true });
    return null;
  },
  async disconnect() {
    streams.closeAll();
    try {
      await clearKey();
    } catch {
      // The key is forgotten in memory regardless; Connect is still where this goes.
    }
    set({ key: null, client: null });
  },
}));
