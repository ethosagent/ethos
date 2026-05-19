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
import type {
  PersonalityRegistry,
  PersonalityRegistryPatch,
  SecretsResolver,
  Storage,
} from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';
import type { McpServerConfig, McpServerInfo } from './index';
import { McpJsonStore, type McpManager } from './index';
import {
  buildAuthorizationUrl,
  type DcrResponse,
  DcrUnsupported,
  type DiscoveredOAuthMetadata,
  discoverOAuthMetadata,
  exchangeCode,
  generateCodeChallenge,
  generateCodeVerifier,
  type OAuthConfig,
  registerOAuthClient,
  storeTokens,
} from './oauth';

export type InstallFlowStatus = 'pending' | 'connected' | 'error' | 'expired';

export interface StartOptions {
  mcpUrl: string;
  name?: string;
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
  attached: string[];
  failed: { id: string; reason: string }[];
}

interface PendingSession {
  state: string;
  mcpUrl: string;
  serverName: string;
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
}

export interface McpInstallFlowOptions {
  mcpManager: McpManager;
  secrets: SecretsResolver;
  storage: Storage;
  personalityRegistry: PersonalityRegistry;
  redirectUri: string;
  /** Storage key for `mcp.json`. Defaults to the platform-standard
   *  `~/.ethos/mcp.json` path inside `McpJsonStore`. */
  mcpJsonKey?: string;
  /** Mid-flight TTL for pending sessions. Default 10 min. */
  pendingTtlMs?: number;
  /** Retention window after a session reaches a terminal state
   *  (`connected` / `error`). Default 60s — long enough for the modal's
   *  polling loop to observe the final state. */
  terminalRetentionMs?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

const DEFAULT_PENDING_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TERMINAL_RETENTION_MS = 60 * 1000;

export class McpInstallFlow {
  private readonly mcpManager: McpManager;
  private readonly secrets: SecretsResolver;
  private readonly storage: Storage;
  private readonly personalityRegistry: PersonalityRegistry;
  private readonly redirectUri: string;
  private readonly mcpJsonStore: McpJsonStore;
  private readonly pendingTtlMs: number;
  private readonly terminalRetentionMs: number;
  private readonly now: () => Date;
  private readonly pending = new Map<string, PendingSession>();

  constructor(opts: McpInstallFlowOptions) {
    this.mcpManager = opts.mcpManager;
    this.secrets = opts.secrets;
    this.storage = opts.storage;
    this.personalityRegistry = opts.personalityRegistry;
    this.redirectUri = opts.redirectUri;
    this.mcpJsonStore =
      opts.mcpJsonKey === undefined
        ? new McpJsonStore(opts.storage)
        : new McpJsonStore(opts.storage, opts.mcpJsonKey);
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
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `MCP server '${serverName}' already exists in mcp.json`,
        action: 'Pick a different `name`, or remove the existing entry first.',
        details: { serverName },
      });
    }
    for (const session of this.pending.values()) {
      if (session.serverName === serverName && session.status === 'pending') {
        throw new EthosError({
          code: 'INVALID_INPUT',
          cause: `An install flow for '${serverName}' is already in progress`,
          action: 'Cancel the existing flow or wait for it to complete.',
          details: { serverName },
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

    // DCR — propagates ConfidentialClientUnsupported when the server returns
    // a client_secret. No rollback needed — nothing has been written yet.
    const dcrResult: DcrResponse = await registerOAuthClient(registrationEndpoint, {
      client_name: 'Ethos',
      redirect_uris: [this.redirectUri],
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

    const authorizeUrl = buildAuthorizationUrl(oauthConfig, this.redirectUri, state, codeChallenge);

    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.pendingTtlMs);

    const dcrMetadata = buildDcrPersistedShape(registrationEndpoint, dcrResult);

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
        details: { state: redactState(opts.state) },
      });
    }

    if (session.status !== 'pending') {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `Install flow for '${session.serverName}' is not pending (status=${session.status})`,
        action: 'Restart the install flow from the UI.',
        details: { serverName: session.serverName, status: session.status },
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
        details: { serverName: session.serverName },
      });
    }

    // Step 1 — exchange code for tokens. Rollback on failure: drop session +
    // placeholder. No tokens to revoke (none stored yet).
    let tokens: Awaited<ReturnType<typeof exchangeCode>>;
    try {
      tokens = await exchangeCode(
        session.oauthConfig,
        opts.code,
        this.redirectUri,
        session.codeVerifier,
      );
    } catch (err) {
      session.status = 'error';
      session.connectedAt = this.now();
      session.errorReason = err instanceof Error ? err.message : String(err);
      await this.rollbackPlaceholder(session.serverName);
      this.pending.delete(opts.state);
      throw err;
    }

    // Step 2 — persist tokens. Rollback on failure: best-effort delete of any
    // tokens that landed before the throw, then drop placeholder + session.
    try {
      await storeTokens(session.serverName, tokens, this.secrets);
    } catch (err) {
      await this.bestEffortDeleteTokens(session.serverName);
      session.status = 'error';
      session.connectedAt = this.now();
      session.errorReason = err instanceof Error ? err.message : String(err);
      await this.rollbackPlaceholder(session.serverName);
      this.pending.delete(opts.state);
      throw err;
    }

    // Step 3 — call mcpManager.addServer. All-or-nothing per the plan: if
    // connect or listTools fails, revoke tokens + roll back placeholder.
    try {
      const serverConfig = buildPersistedConfigFromSession(session);
      await this.mcpManager.addServer(serverConfig);
    } catch (err) {
      await this.bestEffortDeleteTokens(session.serverName);
      session.status = 'error';
      session.connectedAt = this.now();
      session.errorReason = err instanceof Error ? err.message : String(err);
      await this.rollbackPlaceholder(session.serverName);
      this.pending.delete(opts.state);
      throw err;
    }

    // Mark terminal. Keep the session in the map for terminalRetentionMs so
    // polling getStatus continues to see 'connected'. The sweep drops it
    // after the window elapses.
    session.status = 'connected';
    session.connectedAt = this.now();

    return { serverName: session.serverName };
  }

  async getStatus(state: string): Promise<InstallFlowStatus> {
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
    if (session.status === 'pending') {
      await this.rollbackPlaceholder(session.serverName);
    }
    this.pending.delete(state);
  }

  async attachToPersonalities(
    opts: AttachToPersonalitiesOptions,
  ): Promise<AttachToPersonalitiesResult> {
    this.sweep();

    const attached: string[] = [];
    const failed: { id: string; reason: string }[] = [];

    // NOT atomic across personalities. Concurrent updates to the same
    // personality from another tab race against this method; last write wins.
    // v1 limitation — a per-personality write mutex inside PersonalityRegistry
    // is out of scope.
    for (const personalityId of opts.personalityIds) {
      try {
        const current = this.personalityRegistry.get(personalityId);
        if (!current) {
          failed.push({ id: personalityId, reason: `Personality '${personalityId}' not found` });
          continue;
        }

        const currentServers = current.mcp_servers ?? [];
        if (currentServers.includes(opts.serverName)) {
          // Already attached — idempotent no-op for this personality.
          attached.push(personalityId);
          continue;
        }
        const nextServers = [...currentServers, opts.serverName];

        if (!this.personalityRegistry.update) {
          failed.push({
            id: personalityId,
            reason: 'PersonalityRegistry does not support update',
          });
          continue;
        }
        const patch: PersonalityRegistryPatch = { mcp_servers: nextServers };
        await this.personalityRegistry.update(personalityId, patch);
        attached.push(personalityId);
      } catch (err) {
        failed.push({
          id: personalityId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { attached, failed };
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
  private async bestEffortDeleteTokens(serverName: string): Promise<void> {
    try {
      await this.secrets.delete(`mcp/${serverName}/access_token`);
    } catch {
      /* best-effort */
    }
    try {
      await this.secrets.delete(`mcp/${serverName}/refresh_token`);
    } catch {
      /* best-effort */
    }
    try {
      await this.secrets.delete(`mcp/${serverName}/expires_at`);
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
): {
  registration_endpoint: string;
  client_id_issued_at?: number;
  registration_client_uri?: string;
} {
  const shape: {
    registration_endpoint: string;
    client_id_issued_at?: number;
    registration_client_uri?: string;
  } = { registration_endpoint: registrationEndpoint };
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
