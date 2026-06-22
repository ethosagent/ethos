// McpInstallFlow — SDK install-flow state machine for the UI-driven MCP add
// path. Owns the OAuth pending-session map, the `mcp.json` placeholder write,
// token storage, and the final `addServer` call. The web-api transport adapter
// (Phase B.2) is a thin shim over this class — input validation, auth, cookies.
//
// Lifecycle:
//   1. UI calls `start(mcpUrl, name?)`.
//      - Discover OAuth metadata (RFC 8414).
//      - Throw `DcrUnsupported` if the server doesn't advertise registration.
//      - Run DCR (RFC 7591). Throw `ConfidentialClientUnsupported` if the
//        server returned a client_secret.
//      - Generate PKCE verifier + challenge + 32-byte `state`.
//      - Build the authorization URL.
//      - Persist a placeholder `mcp.json` entry (no tokens yet — auth_status
//        is computed lazily from token presence).
//      - Store a `PendingSession` in-memory keyed by `state`.
//      - Return `{ state, authorizeUrl, serverName, expiresAt }`.
//   2. UI opens `authorizeUrl`, user authorizes, provider redirects back with
//      `?code=...&state=...`.
//   3. UI calls `complete({ code, state })`.
//      - Look up pending session by state. CSRF defense.
//      - Exchange code for tokens (`exchangeCode`).
//      - Store tokens via `SecretsResolver`.
//      - Call `mcpManager.addServer(config)` — all-or-nothing.
//      - On any failure: roll back tokens + `mcp.json` entry.
//      - On success: mark session terminal-connected; keep it in the map for
//        `terminalRetentionMs` so polling `getStatus` returns 'connected'.
//   4. UI optionally calls `attachToPersonalities({ serverName, personalityIds })`.
//      - Best-effort per personality (not atomic across the set).
//   5. UI may call `cancel(state)` if the operator aborts; rolls back the
//      placeholder.
//
// Sweep: every public method calls `this.sweep()` first; expired pending
// sessions and expired terminal sessions are dropped from the map.

import { randomBytes } from 'node:crypto';
import { PersonalityScopedSecrets } from '@ethosagent/storage-fs';
import type { SecretsResolver } from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';
import type { McpManager, McpServerConfig, McpServerInfo } from './index';
import type { McpJsonStore } from './mcp-json-store';
import { generateCodeChallenge, generateCodeVerifier } from '@ethosagent/oauth-core';
import {
  buildAuthorizationUrl,
  type DcrResponse,
  DcrUnsupported,
  type DiscoveredOAuthMetadata,
  discoverOAuthMetadata,
  exchangeCode,
  type OAuthConfig,
  registerOAuthClient,
  storeTokens,
} from './oauth';

export type InstallFlowStatus = 'pending' | 'connected' | 'error' | 'expired';

export interface StartOptions {
  mcpUrl: string;
  name?: string;
  /** Personality to scope OAuth tokens to. When omitted, tokens are stored globally. */
  personalityId?: string;
  /**
   * Per-flow OAuth `redirect_uri`. When set, it overrides the
   * constructor-level default and is persisted on the pending session so
   * `complete()` exchanges the code against the same URI that was
   * registered with DCR and used to build the authorization URL (OAuth
   * RFC 6749 §4.1.3 requires the value to match).
   *
   * Used by the web flow to derive the URI from the inbound request's
   * Origin header, so the install works regardless of which host/port the
   * UI is served on.
   */
  redirectUri?: string;
}

export interface StartResult {
  state: string;
  authorizeUrl: string;
  serverName: string;
  expiresAt: Date;
}

export interface CompleteOptions {
  code: string;
  state: string;
}

export interface CompleteResult {
  serverName: string;
}

export interface AttachToPersonalitiesOptions {
  serverName: string;
  personalityIds: string[];
}

export interface AttachToPersonalitiesResult {
  /**
   * Personality ids that now reference this MCP server. Named `updated` (not
   * `attached`) to match the `web-contracts` `McpAttachOutputSchema` exactly.
   */
  updated: string[];
  /**
   * Personalities that could not be updated. `error` (not `reason`) matches
   * the web contract; the payload is a sanitized message safe to surface in
   * the UI.
   */
  failed: { id: string; error: string }[];
}

interface PendingSession {
  state: string;
  mcpUrl: string;
  serverName: string;
  personalityId?: string;
  /**
   * The exact `redirect_uri` that was registered with DCR and embedded in
   * the authorization URL for this flow. `complete()` MUST pass this same
   * string to `exchangeCode` — the token endpoint rejects the exchange if
   * the URIs don't match.
   */
  redirectUri: string;
  codeVerifier: string;
  clientId: string;
  tokenEndpoint: string;
  authorizationEndpoint: string;
  scopes?: string[];
  dcrMetadata: {
    registration_endpoint: string;
    client_id_issued_at?: number;
    registration_client_uri?: string;
  };
  oauthConfig: OAuthConfig;
  discoveredMetadata: DiscoveredOAuthMetadata;
  createdAt: Date;
  expiresAt: Date;
  status: InstallFlowStatus;
  errorReason?: string;
  connectedAt?: Date;
  reauth?: boolean;
}

/**
 * Narrow personality-update interface used by `attachToPersonalities`. Kept
 * local so the install-flow does not need to depend on the full
 * `PersonalityRegistry` interface from `@ethosagent/types`. The web-api
 * (`apps/web-api/src/index.ts`) constructs a literal that satisfies this.
 */
export interface PersonalityUpdater {
  get(id: string): { id: string; mcp_servers?: string[] } | undefined;
  update(id: string, patch: { mcp_servers?: string[] }): Promise<unknown>;
}

export interface McpInstallFlowOptions {
  mcpManager: McpManager;
  secrets: SecretsResolver;
  personalityUpdater: PersonalityUpdater;
  mcpJsonStore: McpJsonStore;
  redirectUri: string;
  /** Mid-flight TTL for pending sessions. Default 10 min. */
  pendingTtlMs?: number;
  /** Retention window after a session reaches a terminal state
   *  (`connected` / `error`). Default 60s — long enough for the modal's
   *  polling loop to observe the final state. */
  terminalRetentionMs?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

/** @deprecated Retained for backward compatibility with earlier wiring. */
export type McpInstallFlowDeps = McpInstallFlowOptions;

const DEFAULT_PENDING_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TERMINAL_RETENTION_MS = 60 * 1000;

export class McpInstallFlow {
  private readonly mcpManager: McpManager;
  private readonly secrets: SecretsResolver;
  private readonly personalityUpdater: PersonalityUpdater;
  private readonly redirectUri: string;
  private readonly mcpJsonStore: McpJsonStore;
  private readonly pendingTtlMs: number;
  private readonly terminalRetentionMs: number;
  private readonly now: () => Date;
  private readonly pending = new Map<string, PendingSession>();

  constructor(opts: McpInstallFlowOptions) {
    this.mcpManager = opts.mcpManager;
    this.secrets = opts.secrets;
    this.personalityUpdater = opts.personalityUpdater;
    this.redirectUri = opts.redirectUri;
    this.mcpJsonStore = opts.mcpJsonStore;
    this.pendingTtlMs =
      opts.pendingTtlMs === undefined ? DEFAULT_PENDING_TTL_MS : opts.pendingTtlMs;
    this.terminalRetentionMs =
      opts.terminalRetentionMs === undefined
        ? DEFAULT_TERMINAL_RETENTION_MS
        : opts.terminalRetentionMs;
    this.now = opts.now === undefined ? () => new Date() : opts.now;
  }

  // --------------------------------------------------------------------------
  // Public surface
  // --------------------------------------------------------------------------

  async start(opts: StartOptions): Promise<StartResult> {
    this.sweep();

    const serverName = opts.name ?? deriveServerName(opts.mcpUrl);
    if (!serverName) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `Could not derive a server name from URL: ${opts.mcpUrl}`,
        action: 'Pass an explicit `name` argument to start().',
        details: { mcpUrl: opts.mcpUrl },
      });
    }

    // Name-collision check against existing mcp.json entries. The pending
    // sessions are checked separately — a half-finished flow under the same
    // name is an in-flight collision too.
    const existing = await this.mcpJsonStore.get(serverName);
    if (existing) {
      const auth = existing.auth;
      if (
        auth?.type === 'oauth2' &&
        auth.client_id &&
        auth.authorization_endpoint &&
        auth.token_endpoint &&
        auth.dcr?.registration_endpoint
      ) {
        // Server is already registered — this is a re-auth flow. Reuse the
        // stored client_id and endpoints; skip discovery and DCR.
        const redirectUri = auth.dcr?.redirect_uri ?? opts.redirectUri ?? this.redirectUri;
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const state = randomBytes(32).toString('base64url');

        const oauthConfig: OAuthConfig = {
          authorization_endpoint: auth.authorization_endpoint,
          token_endpoint: auth.token_endpoint,
          client_id: auth.client_id,
        };
        if (auth.revocation_endpoint) oauthConfig.revocation_endpoint = auth.revocation_endpoint;
        if (auth.scopes && auth.scopes.length > 0) oauthConfig.scopes = auth.scopes;

        const discoveredMetadata: DiscoveredOAuthMetadata = {
          authorization_endpoint: auth.authorization_endpoint,
          token_endpoint: auth.token_endpoint,
          registration_endpoint: auth.dcr.registration_endpoint,
          ...(auth.revocation_endpoint ? { revocation_endpoint: auth.revocation_endpoint } : {}),
          ...(auth.scopes ? { scopes_supported: auth.scopes } : {}),
        };

        const authorizeUrl = buildAuthorizationUrl(oauthConfig, redirectUri, state, codeChallenge);
        const createdAt = this.now();
        const expiresAt = new Date(createdAt.getTime() + this.pendingTtlMs);

        const session: PendingSession = {
          state,
          mcpUrl: existing.url ?? opts.mcpUrl,
          serverName,
          redirectUri,
          codeVerifier,
          clientId: auth.client_id,
          tokenEndpoint: auth.token_endpoint,
          authorizationEndpoint: auth.authorization_endpoint,
          dcrMetadata: {
            registration_endpoint: auth.dcr.registration_endpoint,
            ...(auth.dcr.client_id_issued_at !== undefined
              ? { client_id_issued_at: auth.dcr.client_id_issued_at }
              : {}),
            ...(auth.dcr.registration_client_uri !== undefined
              ? { registration_client_uri: auth.dcr.registration_client_uri }
              : {}),
          },
          oauthConfig,
          discoveredMetadata,
          createdAt,
          expiresAt,
          status: 'pending',
          reauth: true,
          ...(opts.personalityId !== undefined ? { personalityId: opts.personalityId } : {}),
          ...(auth.scopes && auth.scopes.length > 0 ? { scopes: auth.scopes } : {}),
        };
        this.pending.set(state, session);
        return { state, authorizeUrl, serverName, expiresAt };
      }

      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `MCP server '${serverName}' already exists in mcp.json`,
        action: 'Pick a different `name`, or remove the existing entry first.',
        details: { serverName, kind: 'name_taken' },
      });
    }
    for (const session of this.pending.values()) {
      if (session.serverName === serverName && session.status === 'pending') {
        throw new EthosError({
          code: 'INVALID_INPUT',
          cause: `An install flow for '${serverName}' is already in progress`,
          action: 'Cancel the existing flow or wait for it to complete.',
          details: { serverName, kind: 'name_taken' },
        });
      }
    }

    // Discovery — propagate OAuthDiscoveryError verbatim.
    const metadata = await discoverOAuthMetadata(opts.mcpUrl);

    // DCR support check — discovery succeeded but the server doesn't advertise
    // a registration endpoint. UI flow has no way forward without DCR.
    if (!metadata.registration_endpoint) {
      throw new DcrUnsupported(opts.mcpUrl);
    }
    const registrationEndpoint = metadata.registration_endpoint;

    // Per-flow redirect URI (e.g. derived from the web request's Origin)
    // takes precedence over the constructor-level default. Whatever we
    // pick here is what gets registered with DCR, embedded in the
    // authorization URL, and persisted on the session for the eventual
    // code-exchange call — those three MUST all match per OAuth.
    const redirectUri = opts.redirectUri ?? this.redirectUri;

    // DCR — propagates ConfidentialClientUnsupported when the server returns
    // a client_secret. No rollback needed — nothing has been written yet.
    const dcrResult: DcrResponse = await registerOAuthClient(registrationEndpoint, {
      client_name: 'Ethos',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none' as const,
      grant_types: ['authorization_code', 'refresh_token'] as [
        'authorization_code',
        'refresh_token',
      ],
      response_types: ['code'] as ['code'],
    });

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = randomBytes(32).toString('base64url');

    const oauthConfig: OAuthConfig = {
      authorization_endpoint: metadata.authorization_endpoint,
      token_endpoint: metadata.token_endpoint,
      client_id: dcrResult.client_id,
    };
    if (metadata.revocation_endpoint) {
      oauthConfig.revocation_endpoint = metadata.revocation_endpoint;
    }
    const scopes = metadata.scopes_supported;
    if (scopes && scopes.length > 0) {
      oauthConfig.scopes = scopes;
    }

    const authorizeUrl = buildAuthorizationUrl(oauthConfig, redirectUri, state, codeChallenge);

    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.pendingTtlMs);

    const dcrMetadata = buildDcrPersistedShape(registrationEndpoint, dcrResult, redirectUri);

    // Persist the placeholder mcp.json entry BEFORE storing the pending
    // session — once written it becomes the rollback target. The placeholder
    // marker is the absence of stored tokens; no `auth_status` field is
    // persisted (it's lazy-computed on read).
    const placeholderConfig: McpServerConfig = {
      name: serverName,
      transport: 'streamable-http',
      url: opts.mcpUrl,
      auth: buildAuthBlock({
        clientId: dcrResult.client_id,
        metadata,
        dcrMetadata,
        scopes,
      }),
      created_via: 'ui' as const,
    };

    // First persistent action — nothing to roll back if this throws.
    await this.mcpJsonStore.upsert(serverName, placeholderConfig);

    const session: PendingSession = {
      state,
      mcpUrl: opts.mcpUrl,
      serverName,
      personalityId: opts.personalityId,
      redirectUri,
      codeVerifier,
      clientId: dcrResult.client_id,
      tokenEndpoint: metadata.token_endpoint,
      authorizationEndpoint: metadata.authorization_endpoint,
      dcrMetadata,
      oauthConfig,
      discoveredMetadata: metadata,
      createdAt,
      expiresAt,
      status: 'pending',
    };
    if (scopes && scopes.length > 0) session.scopes = scopes;
    this.pending.set(state, session);

    return { state, authorizeUrl, serverName, expiresAt };
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    this.sweep();

    const session = this.pending.get(opts.state);
    if (!session) {
      throw new EthosError({
        code: 'NOT_FOUND',
        cause: 'No pending OAuth install flow for the supplied state',
        action: 'Restart the install flow from the UI.',
        details: { state: redactState(opts.state), kind: 'expired_state' },
      });
    }

    if (session.status !== 'pending') {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `Install flow for '${session.serverName}' is not pending (status=${session.status})`,
        action: 'Restart the install flow from the UI.',
        details: {
          serverName: session.serverName,
          status: session.status,
          kind: 'already_completed',
        },
      });
    }

    if (session.expiresAt.getTime() < this.now().getTime()) {
      // Expired between the sweep above and this check (clock drift, or a
      // tightly raced caller). Drop the session and the placeholder.
      session.status = 'expired';
      session.connectedAt = this.now();
      await this.rollbackPlaceholder(session.serverName);
      this.pending.delete(opts.state);
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `Install flow for '${session.serverName}' has expired`,
        action: 'Restart the install flow from the UI.',
        details: { serverName: session.serverName, kind: 'expired_state' },
      });
    }

    // Step 1 — exchange code for tokens. Rollback on failure: drop session +
    // placeholder. No tokens to revoke (none stored yet).
    let tokens: Awaited<ReturnType<typeof exchangeCode>>;
    try {
      tokens = await exchangeCode(
        session.oauthConfig,
        opts.code,
        session.redirectUri,
        session.codeVerifier,
      );
    } catch (err) {
      session.status = 'error';
      session.connectedAt = this.now();
      session.errorReason = err instanceof Error ? err.message : String(err);
      if (!session.reauth) await this.rollbackPlaceholder(session.serverName);
      this.pending.delete(opts.state);
      throw err;
    }

    // Step 2 — persist tokens. Rollback on failure: best-effort delete of any
    // tokens that landed before the throw, then drop placeholder + session.
    const scopedSecrets = session.personalityId
      ? new PersonalityScopedSecrets(this.secrets, session.personalityId)
      : this.secrets;
    try {
      await storeTokens(session.serverName, tokens, scopedSecrets);
    } catch (err) {
      await this.bestEffortDeleteTokens(session.serverName, session.personalityId);
      session.status = 'error';
      session.connectedAt = this.now();
      session.errorReason = err instanceof Error ? err.message : String(err);
      if (!session.reauth) await this.rollbackPlaceholder(session.serverName);
      this.pending.delete(opts.state);
      throw err;
    }

    // Step 3 — add/reconnect the server in the MCP manager.
    // For re-auth, the server is already registered — skip addServer (it throws for
    // duplicates) and instead evict the stale per-personality client so the next
    // getToolsForPersonality call reconnects with the fresh token.
    if (session.reauth) {
      await this.mcpManager.reconnectPersonality(session.serverName, session.personalityId ?? '');
    } else {
      // New server: all-or-nothing. If connect or listTools fails, roll back tokens + placeholder.
      try {
        const serverConfig = buildPersistedConfigFromSession(session);
        await this.mcpManager.addServer(serverConfig);
      } catch (err) {
        await this.bestEffortDeleteTokens(session.serverName, session.personalityId);
        session.status = 'error';
        session.connectedAt = this.now();
        session.errorReason = err instanceof Error ? err.message : String(err);
        await this.rollbackPlaceholder(session.serverName);
        this.pending.delete(opts.state);
        throw err;
      }
    }

    // Mark terminal. Keep the session in the map for terminalRetentionMs so
    // polling getStatus continues to see 'connected'. The sweep drops it
    // after the window elapses.
    session.status = 'connected';
    session.connectedAt = this.now();

    return { serverName: session.serverName };
  }

  getStatus(state: string): InstallFlowStatus {
    this.sweep();

    const session = this.pending.get(state);
    if (!session) return 'expired';

    if (
      (session.status === 'connected' || session.status === 'error') &&
      session.connectedAt !== undefined &&
      this.now().getTime() - session.connectedAt.getTime() > this.terminalRetentionMs
    ) {
      this.pending.delete(state);
      return 'expired';
    }

    return session.status;
  }

  async cancel(state: string): Promise<void> {
    this.sweep();

    const session = this.pending.get(state);
    if (!session) return; // no-op for unknown / already-swept

    // Only roll back the placeholder for sessions that never reached a
    // terminal-connected state. A successfully-connected server is operator-
    // owned at this point and `cancel` must not silently uninstall it.
    if (session.status === 'pending' && !session.reauth) {
      await this.rollbackPlaceholder(session.serverName);
    }
    this.pending.delete(state);
  }

  async attachToPersonalities(
    opts: AttachToPersonalitiesOptions,
  ): Promise<AttachToPersonalitiesResult> {
    this.sweep();

    const updated: string[] = [];
    const failed: { id: string; error: string }[] = [];

    // NOT atomic across personalities. Concurrent updates to the same
    // personality from another tab race against this method; last write wins.
    // v1 limitation — a per-personality write mutex inside PersonalityRegistry
    // is out of scope.
    for (const personalityId of opts.personalityIds) {
      try {
        const current = this.personalityUpdater.get(personalityId);
        if (!current) {
          failed.push({ id: personalityId, error: `Personality '${personalityId}' not found` });
          continue;
        }

        const currentServers = current.mcp_servers ?? [];
        if (currentServers.includes(opts.serverName)) {
          // Already attached — idempotent no-op for this personality.
          updated.push(personalityId);
          continue;
        }
        const nextServers = [...currentServers, opts.serverName];

        await this.personalityUpdater.update(personalityId, { mcp_servers: nextServers });
        updated.push(personalityId);
      } catch (err) {
        failed.push({
          id: personalityId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { updated, failed };
  }

  listServers(): McpServerInfo[] {
    this.sweep();
    return this.mcpManager.listServers();
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  /**
   * Drop expired pending and terminal sessions. Called at the head of every
   * public method (eager-on-touch sweep). O(n) where n is the number of
   * concurrent install flows — typically 1–2.
   */
  private sweep(): void {
    const nowMs = this.now().getTime();
    for (const [state, session] of this.pending) {
      if (session.status === 'pending') {
        if (session.expiresAt.getTime() < nowMs) {
          // Mid-flight TTL elapsed. We do NOT roll back the placeholder here
          // — the operator may complete the flow later by re-running start,
          // and surfacing a half-written entry to the next list call is
          // preferable to silently uninstalling a partial state. (Phase B.2
          // owns the policy for cleaning up orphaned placeholders.)
          this.pending.delete(state);
        }
      } else if (
        (session.status === 'connected' || session.status === 'error') &&
        session.connectedAt !== undefined &&
        nowMs - session.connectedAt.getTime() > this.terminalRetentionMs
      ) {
        this.pending.delete(state);
      } else if (session.status === 'expired') {
        this.pending.delete(state);
      }
    }
  }

  /**
   * Remove the `mcp.json` placeholder for a server. Best-effort: surface
   * errors via the caller's path. Used during rollback when the install
   * flow fails after the placeholder was written.
   */
  private async rollbackPlaceholder(serverName: string): Promise<void> {
    try {
      await this.mcpJsonStore.remove(serverName);
    } catch {
      // Best-effort. A stranded entry is preferable to a thrown rollback
      // masking the original cause of the install failure.
    }
  }

  /**
   * Best-effort delete of the three secret refs `storeTokens` writes
   * (access / refresh / expires_at). Used when token storage partially
   * succeeded or when we need to revoke after a downstream failure.
   */
  private async bestEffortDeleteTokens(serverName: string, personalityId?: string): Promise<void> {
    const secrets = personalityId
      ? new PersonalityScopedSecrets(this.secrets, personalityId)
      : this.secrets;
    try {
      await secrets.delete(`mcp/${serverName}/access_token`);
    } catch {
      /* best-effort */
    }
    try {
      await secrets.delete(`mcp/${serverName}/refresh_token`);
    } catch {
      /* best-effort */
    }
    try {
      await secrets.delete(`mcp/${serverName}/expires_at`);
    } catch {
      /* best-effort */
    }
  }
}

// ----------------------------------------------------------------------------
// Helpers (non-class)
// ----------------------------------------------------------------------------

/**
 * Derive a default server name from an MCP URL. e.g. `https://mcp.linear.app/sse`
 * → `linear`. Falls back to the hostname's last meaningful segment.
 * Returns the empty string if nothing usable can be extracted.
 */
function deriveServerName(mcpUrl: string): string {
  let host: string;
  try {
    host = new URL(mcpUrl).hostname;
  } catch {
    return '';
  }
  if (!host) return '';
  // Split into labels. Drop the public TLD and the `mcp` / `api` / `www`
  // prefix labels, then pick the most-specific remaining label.
  const labels = host.split('.').filter((l) => l.length > 0);
  if (labels.length === 0) return '';
  const skipPrefixes = new Set(['mcp', 'api', 'www']);
  const meaningful = labels.filter((l) => !skipPrefixes.has(l.toLowerCase()));
  // If everything was filtered out, fall back to the leftmost label.
  const candidates = meaningful.length > 0 ? meaningful : labels;
  // For a TLD like `linear.app`, the meaningful labels are `['linear', 'app']`.
  // The first remaining label is the brand. For an IP or single-label host,
  // there's only one candidate.
  return candidates[0] ?? '';
}

function buildDcrPersistedShape(
  registrationEndpoint: string,
  dcr: DcrResponse,
  redirectUri: string,
): {
  registration_endpoint: string;
  client_id_issued_at?: number;
  registration_client_uri?: string;
  redirect_uri?: string;
} {
  const shape: {
    registration_endpoint: string;
    client_id_issued_at?: number;
    registration_client_uri?: string;
    redirect_uri?: string;
  } = { registration_endpoint: registrationEndpoint, redirect_uri: redirectUri };
  if (dcr.client_id_issued_at !== undefined) shape.client_id_issued_at = dcr.client_id_issued_at;
  if (dcr.registration_client_uri !== undefined) {
    shape.registration_client_uri = dcr.registration_client_uri;
  }
  return shape;
}

function buildPersistedConfigFromSession(session: PendingSession): McpServerConfig {
  return {
    name: session.serverName,
    transport: 'streamable-http',
    url: session.mcpUrl,
    auth: buildAuthBlock({
      clientId: session.clientId,
      metadata: session.discoveredMetadata,
      dcrMetadata: session.dcrMetadata,
      scopes: session.scopes,
    }),
    created_via: 'ui' as const,
  };
}

function buildAuthBlock(input: {
  clientId: string;
  metadata: DiscoveredOAuthMetadata;
  dcrMetadata: {
    registration_endpoint: string;
    client_id_issued_at?: number;
    registration_client_uri?: string;
  };
  scopes?: string[];
}): NonNullable<McpServerConfig['auth']> {
  const auth: NonNullable<McpServerConfig['auth']> = {
    type: 'oauth2' as const,
    authorization_endpoint: input.metadata.authorization_endpoint,
    token_endpoint: input.metadata.token_endpoint,
    client_id: input.clientId,
    dcr: input.dcrMetadata,
  };
  if (input.metadata.revocation_endpoint) {
    auth.revocation_endpoint = input.metadata.revocation_endpoint;
  }
  if (input.metadata.introspection_endpoint) {
    auth.introspection_endpoint = input.metadata.introspection_endpoint;
  }
  if (input.scopes && input.scopes.length > 0) {
    auth.scopes = input.scopes;
  }
  return auth;
}

/**
 * Render only the first 8 chars of a state token for error details — the
 * full token is sensitive (CSRF defense). Surfaces show this so an operator
 * can correlate logs without revealing the full secret.
 */
function redactState(state: string): string {
  if (state.length <= 8) return '****';
  return `${state.slice(0, 8)}…`;
}

// Re-export the typed errors that consumers will need to catch.
export { ConfidentialClientUnsupported, DcrUnsupported, OAuthDiscoveryError } from './oauth';
