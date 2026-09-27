// Settings → Mobile app: connect a phone (plan/phases/mobile-app.md T-WEB, S7,
// D3). Pure, DOM-free state machine + helpers — no React, no network, no
// storage import. The plaintext secret exists in this module's state ONLY
// while `phase === 'revealed'` (shown once, right after `apiKeys.create`,
// while the web waits for the phone to scan it); every other phase carries
// `key: null`. Nothing here ever touches `localStorage`/`sessionStorage`.

import type { ApiKeyMetadata, ApiKeyScope } from '@ethosagent/web-contracts';
import { PHONE_OPTIONAL_PRESET_SCOPES, PHONE_PRESET_SCOPES } from '@ethosagent/web-contracts';

/** D3: `ethos://connect?url=<url>&key=<secret>` — scan-only, never rendered as an anchor. */
export function buildConnectString(url: string, key: string): string {
  return `ethos://connect?url=${encodeURIComponent(url)}&key=${encodeURIComponent(key)}`;
}

/** Not revoked, and its scopes cover every required phone scope (D2) — extra scopes are fine.
 *  A preset scope in `PHONE_OPTIONAL_PRESET_SCOPES` is not required, so a phone
 *  key minted before it joined the preset stays in "Connected phones". */
export function isPhoneKey(key: Pick<ApiKeyMetadata, 'scopes' | 'revokedAt'>): boolean {
  if (key.revokedAt !== null) return false;
  const scopes = new Set(key.scopes as ApiKeyScope[]);
  const optional = new Set<ApiKeyScope>(PHONE_OPTIONAL_PRESET_SCOPES);
  return PHONE_PRESET_SCOPES.every((scope) => optional.has(scope) || scopes.has(scope));
}

/** 10 minutes with no connect — the QR and secret are dropped (T-WEB §4). */
export const CONNECT_TIMEOUT_MS = 10 * 60 * 1000;

export type MobileConnectPhase = 'idle' | 'generating' | 'revealed' | 'connected' | 'expired';

export interface MobileConnectState {
  phase: MobileConnectPhase;
  keyId: string | null;
  url: string | null;
  /** Present ONLY while `phase === 'revealed'`. Never persisted. */
  key: string | null;
  /** Epoch ms the key was minted. Non-null only in `'revealed'`. */
  mintedAt: number | null;
}

export const IDLE_STATE: MobileConnectState = {
  phase: 'idle',
  keyId: null,
  url: null,
  key: null,
  mintedAt: null,
};

/** Generate QR code clicked — `apiKeys.create` is in flight. */
export function startGenerating(): MobileConnectState {
  return { phase: 'generating', keyId: null, url: null, key: null, mintedAt: null };
}

/** `apiKeys.create` resolved — the secret is shown once, right here. */
export function reveal(input: {
  keyId: string;
  url: string;
  key: string;
  now: number;
}): MobileConnectState {
  return {
    phase: 'revealed',
    keyId: input.keyId,
    url: input.url,
    key: input.key,
    mintedAt: input.now,
  };
}

/**
 * The connect signal: the phone's first authenticated call (`meta.whoami`)
 * writes `lastUsed` on the key, so a poll of `apiKeys.list` whose row for this
 * key shows `lastUsed` flip from `null` to a timestamp means the phone
 * connected. A no-op outside `'revealed'`, or while `lastUsed` is still `null`.
 */
export function applyLastUsed(
  state: MobileConnectState,
  lastUsed: string | null,
): MobileConnectState {
  if (state.phase !== 'revealed') return state;
  if (lastUsed === null) return state;
  return { phase: 'connected', keyId: state.keyId, url: null, key: null, mintedAt: null };
}

/** 10 minutes with no connect — the QR and secret are dropped (`not connected yet`). */
export function applyTimeout(state: MobileConnectState, now: number): MobileConnectState {
  if (state.phase !== 'revealed') return state;
  if (state.mintedAt === null) return state;
  if (now - state.mintedAt < CONNECT_TIMEOUT_MS) return state;
  return { phase: 'expired', keyId: state.keyId, url: null, key: null, mintedAt: null };
}

/** Reopening "connect a phone" after `expired`/`connected` starts a fresh attempt. */
export function resetConnect(): MobileConnectState {
  return IDLE_STATE;
}

// ---------------------------------------------------------------------------
// Reachability — the shape `meta.connectInfo` (S13) returns.
// ---------------------------------------------------------------------------

export interface MobileConnectInfo {
  url: string;
  source: 'ETHOS_PUBLIC_URL' | 'webBaseUrl' | 'web.host';
  loopback: boolean;
}

/** Loopback: no phone can reach this server, so Generate (and the host field) are removed
 *  rather than disabled (§11a rule 2 — a control that cannot work is not offered). */
export function canGenerateQr(info: MobileConnectInfo): boolean {
  return !info.loopback;
}
