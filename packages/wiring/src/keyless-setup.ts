// ---------------------------------------------------------------------------
// Thin seams the CLI setup needs from extensions (keyless-first-run §3.2, §5.2).
// Apps reach extensions only through wiring (archcheck l5-apps-through-wiring),
// so the consented Codex import and the connector presets are re-exposed here.
//
// Guarantees:
//  - `importExternalLogin` returns only `{ ok }` / `{ ok:false, reason }`, never
//    token material: pinned by CodexTokenStore.importExternal's result type
//    (extensions/llm-codex/src/token-store.ts ImportExternalResult).
//  - Only authType 'none' presets are written by `addNoSignInPresets`; the
//    filter is `noSignInPresets()`, pinned by
//    apps/ethos/src/commands/__tests__/setup-connectors.test.ts.
// ---------------------------------------------------------------------------

import { join } from 'node:path';
import {
  CodexTokenStore,
  type ExternalLoginSource,
  exchangeForTokens,
  type ImportExternalResult,
  pollForAuthorization,
  requestDeviceCode,
} from '@ethosagent/llm-codex';
import { FileSecretsResolver, FsStorage } from '@ethosagent/storage-fs';
import { MCP_REMOTE_PRESETS, McpJsonStore, type McpRemotePreset } from '@ethosagent/tools-mcp';
import type { SecretsResolver, Storage } from '@ethosagent/types';

export type { ExternalLoginSource, ImportExternalResult, McpRemotePreset };

/** Copy an external Codex/Hermes login into the Ethos vault. Call only after an explicit yes (D3). */
export async function importExternalLogin(opts: {
  secrets: SecretsResolver;
  source: ExternalLoginSource;
  home?: string;
}): Promise<ImportExternalResult> {
  const store = new CodexTokenStore(opts.secrets, opts.home ? { home: opts.home } : {});
  return store.importExternal(opts.source);
}

/** Presets that need no sign-in (authType 'none'), derived from the catalog, never hand-listed. */
export function noSignInPresets(): McpRemotePreset[] {
  return Object.values(MCP_REMOTE_PRESETS).filter((p) => p.authType === 'none');
}

/** Presets that need an OAuth sign-in (shown as commands in the CLI, D21). */
export function oauthPresets(): McpRemotePreset[] {
  return Object.values(MCP_REMOTE_PRESETS).filter((p) => p.authType === 'oauth');
}

/**
 * Upsert the named no-sign-in presets into mcp.json. Unknown or non-'none'
 * names are skipped. Returns the names written, in input order.
 */
export async function addNoSignInPresets(
  storage: Storage,
  names: readonly string[],
  mcpJsonPath?: string,
): Promise<string[]> {
  const store = new McpJsonStore(storage, mcpJsonPath);
  const allowed = new Map(noSignInPresets().map((p) => [p.name, p]));
  const written: string[] = [];
  for (const name of names) {
    const preset = allowed.get(name);
    if (!preset) continue;
    await store.upsert(name, {
      name,
      transport: 'streamable-http',
      url: preset.url,
      created_via: 'cli',
    });
    written.push(name);
  }
  return written;
}

export const CODEX_DEVICE_URL = 'https://auth.openai.com/codex/device';

/**
 * "Sign in with ChatGPT": the device flow, which gives Ethos its own grant
 * (plan §3.2). `onUserCode` shows the code to the person; tokens go straight to
 * the vault and are never returned. Throws on failure or abort.
 */
export async function runCodexDeviceLogin(opts: {
  secrets: SecretsResolver;
  onUserCode: (userCode: string, url: string) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const f = opts.fetchImpl ?? globalThis.fetch;
  const { deviceAuthId, userCode } = await requestDeviceCode(f);
  opts.onUserCode(userCode, CODEX_DEVICE_URL);
  const { authorizationCode, codeVerifier } = await pollForAuthorization(
    f,
    deviceAuthId,
    userCode,
    opts.signal,
  );
  const credentials = await exchangeForTokens(f, authorizationCode, codeVerifier);
  await new CodexTokenStore(opts.secrets).save(credentials);
}

/** The on-disk Ethos vault under `<stateDir>/secrets`, for surfaces (the TUI wizard) that hold no resolver. */
export function openFileVault(stateDir: string): SecretsResolver {
  return new FileSecretsResolver({ dir: join(stateDir, 'secrets'), storage: new FsStorage() });
}
