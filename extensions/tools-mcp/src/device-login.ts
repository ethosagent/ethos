// McpDeviceLogin / McpPasteLogin — headless OAuth sign-in for MCP servers.
//
// McpDeviceLogin runs RFC 8628 (device-flow.ts). McpPasteLogin runs the PKCE
// authorization-code flow without a listener: the user opens the authorize URL
// elsewhere and pastes back the loopback address the browser ended on.
//
// Both write a grant exactly as McpInstallFlow.complete does: `storeTokens`
// with a TokenBinding, scoped to the personality when one is named. Both share
// one `LoginSlots` (pending map, one flow per (personality, server) grant slot,
// process-wide cap) — pinned by __tests__/device-login.test.ts
// "a paste flow and a device flow share the one-pending-per-slot rule".
//
// Nothing secret reaches the Logger or `recordEvent`: user_code, device_code,
// authorization code, state, verifier, pasted text and token-endpoint bodies
// are never passed to either. Pinned by __tests__/device-login.test.ts
// "no secret reaches the logger".

import { randomBytes } from 'node:crypto';
import { noopLogger } from '@ethosagent/logger';
import { generateCodeChallenge, generateCodeVerifier } from '@ethosagent/oauth-core';
import { PersonalityScopedSecrets } from '@ethosagent/storage-fs';
import type { Logger, SecretsResolver } from '@ethosagent/types';
import {
  createDeviceFlowDeps,
  type DeviceAuthorization,
  DeviceAuthorizationError,
  DeviceFlowBlockedError,
  type DeviceFlowDeps,
  pollDeviceToken,
  requestDeviceAuthorization,
} from './device-flow';
import type { McpManager, McpServerConfig } from './index';
import type { McpJsonStore } from './mcp-json-store';
import {
  bindingFor,
  buildAuthorizationUrl,
  discoverOAuthMetadata,
  exchangeCode,
  hrefOf,
  isLoopbackRedirectUri,
  type OAuthConfig,
  OAuthIssuerMismatch,
  PastedRedirectError,
  parsePastedRedirect,
  readBinding,
  safeUrl,
  storeTokens,
  type TokenSet,
} from './oauth';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LoginSurface = 'cli' | 'web' | 'gateway';
export type LoginStatus = 'pending' | 'connected' | 'denied' | 'expired' | 'cancelled' | 'error';
export type LoginSettledStatus = Exclude<LoginStatus, 'pending'>;

export interface LoginStatusResult {
  status: LoginStatus;
  serverName?: string;
  reason?: string;
}

export interface LoginSettlement {
  status: LoginSettledStatus;
  reason?: string;
}

export interface StartLoginInput {
  serverName: string;
  personalityId?: string;
  surface: LoginSurface;
}

type CommonFailure = 'not_found' | 'not_oauth' | 'already_pending' | 'too_many_pending';

export type DeviceStartFailureCode =
  | CommonFailure
  | 'device_unavailable'
  | 'device_refused'
  | 'discovery_failed';

export type StartDeviceResult =
  | {
      ok: true;
      flowId: string;
      userCode: string;
      verificationUri: string;
      verificationUriComplete?: string;
      /** Epoch ms. */
      expiresAt: number;
      serverName: string;
      serverHost: string;
      authHost: string;
      personalityId?: string;
    }
  | { ok: false; code: DeviceStartFailureCode; detail?: string };

export type PasteStartFailureCode = CommonFailure | 'paste_unavailable';

export type StartPasteResult =
  | {
      ok: true;
      flowId: string;
      authorizeUrl: string;
      /** Epoch ms. */
      expiresAt: number;
      serverName: string;
      serverHost: string;
      authHost: string;
      personalityId?: string;
    }
  | { ok: false; code: PasteStartFailureCode; detail?: string };

export type CompletePasteResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'not_pending'
        | 'invalid_paste'
        | 'state_mismatch'
        | 'issuer_mismatch'
        | 'denied'
        | 'exchange_failed'
        | 'store_failed';
    };

/** One audit record per attempt phase (plan §9.3). Carries no secret. */
export interface LoginAuditEvent {
  server: string;
  personalityId?: string;
  flow: 'device' | 'paste';
  surface: LoginSurface;
  authHost?: string;
  outcome: 'started' | LoginSettledStatus | 'refused';
  code?: string;
  polls?: number;
  durationMs?: number;
}

export interface LoginSlotsOptions {
  logger?: Logger;
  recordEvent?: (event: LoginAuditEvent) => void;
  now?: () => number;
  /** Process-wide cap on concurrent pending flows. Default 10. */
  maxPending?: number;
  /** How long a terminal entry stays readable by `status`. Default 60 s. */
  terminalRetentionMs?: number;
}

const DEFAULT_MAX_PENDING = 10;
const DEFAULT_TERMINAL_RETENTION_MS = 60_000;
const PASTE_TTL_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// LoginSlots — the shared pending map
// ---------------------------------------------------------------------------

interface Slot {
  flowId: string;
  key: string;
  kind: 'device' | 'paste';
  serverName: string;
  personalityId?: string;
  surface: LoginSurface;
  authHost?: string;
  status: LoginStatus;
  reason?: string;
  startedAt: number;
  settledAt?: number;
  /** Paste flows only: `sweep` expires the slot at this time. Device flows expire through the poller. */
  expiresAt?: number;
  /** Self-driving expiry for paste flows; cleared by `settle` and `refuse`. Enforced by the paste-TTL test in device-login.test.ts. */
  expiryTimer?: ReturnType<typeof setTimeout>;
  abort: AbortController;
  polls: number;
  listeners: Set<(s: LoginSettlement) => void>;
}

type ReserveResult =
  | { ok: true; slot: Slot }
  | { ok: false; code: 'already_pending' | 'too_many_pending'; detail?: string };

/** The pending map, cap and key shared by McpDeviceLogin and McpPasteLogin. Pass one instance to both. */
export class LoginSlots {
  readonly logger: Logger;
  readonly now: () => number;
  private readonly recordEvent?: (event: LoginAuditEvent) => void;
  private readonly maxPending: number;
  private readonly retentionMs: number;
  private readonly flows = new Map<string, Slot>();

  constructor(opts: LoginSlotsOptions = {}) {
    this.logger = opts.logger ?? noopLogger;
    this.now = opts.now ?? Date.now;
    this.recordEvent = opts.recordEvent;
    this.maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
    this.retentionMs = opts.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
  }

  static keyFor(personalityId: string | undefined, serverName: string): string {
    return `${personalityId ?? ''}::${serverName}`;
  }

  /** Drop expired terminal entries and expire overdue paste flows. */
  sweep(): void {
    const now = this.now();
    for (const slot of [...this.flows.values()]) {
      if (slot.status === 'pending') {
        if (slot.expiresAt !== undefined && now >= slot.expiresAt) this.settle(slot, 'expired');
      } else if (slot.settledAt !== undefined && now - slot.settledAt > this.retentionMs) {
        this.flows.delete(slot.flowId);
      }
    }
  }

  reserve(input: {
    serverName: string;
    personalityId?: string;
    surface: LoginSurface;
    kind: 'device' | 'paste';
    expiresAt?: number;
  }): ReserveResult {
    this.sweep();
    const key = LoginSlots.keyFor(input.personalityId, input.serverName);
    let pending = 0;
    for (const slot of this.flows.values()) {
      if (slot.status !== 'pending') continue;
      pending++;
      if (slot.key === key) {
        return {
          ok: false,
          code: 'already_pending',
          detail: `A sign-in for ${input.serverName} is already waiting.`,
        };
      }
    }
    if (pending >= this.maxPending) {
      return { ok: false, code: 'too_many_pending', detail: 'Too many sign-ins are in progress.' };
    }
    const slot: Slot = {
      flowId: randomBytes(16).toString('base64url'),
      key,
      kind: input.kind,
      serverName: input.serverName,
      ...(input.personalityId !== undefined ? { personalityId: input.personalityId } : {}),
      surface: input.surface,
      status: 'pending',
      startedAt: this.now(),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      abort: new AbortController(),
      polls: 0,
      listeners: new Set(),
    };
    if (slot.expiresAt !== undefined) {
      const timer = setTimeout(
        () => this.settle(slot, 'expired'),
        Math.max(0, slot.expiresAt - this.now()),
      );
      timer.unref?.();
      slot.expiryTimer = timer;
    }
    this.flows.set(slot.flowId, slot);
    return { ok: true, slot };
  }

  /** Drop a reserved slot that never started (a refusal), and audit the refusal. */
  refuse(slot: Slot, code: string): void {
    clearTimeout(slot.expiryTimer);
    this.flows.delete(slot.flowId);
    this.emit(slot, 'refused', code);
  }

  /** Audit the start of a flow that is now running. */
  started(slot: Slot): void {
    this.emit(slot, 'started');
  }

  settle(slot: Slot, status: LoginSettledStatus, reason?: string): void {
    if (slot.status !== 'pending') return;
    clearTimeout(slot.expiryTimer);
    slot.status = status;
    if (reason !== undefined) slot.reason = reason;
    slot.settledAt = this.now();
    slot.abort.abort();
    this.emit(slot, status, status === 'error' ? reason : undefined);
    for (const cb of [...slot.listeners])
      this.notify(cb, { status, ...(reason ? { reason } : {}) });
    slot.listeners.clear();
  }

  status(flowId: string): LoginStatusResult {
    this.sweep();
    const slot = this.flows.get(flowId);
    if (!slot) return { status: 'expired' };
    return {
      status: slot.status,
      serverName: slot.serverName,
      ...(slot.reason ? { reason: slot.reason } : {}),
    };
  }

  cancel(flowId: string): void {
    const slot = this.flows.get(flowId);
    if (slot) this.settle(slot, 'cancelled');
  }

  /** Calls `cb` once when the flow settles. Already settled or unknown: called at once. */
  onSettled(flowId: string, cb: (s: LoginSettlement) => void): void {
    const slot = this.flows.get(flowId);
    if (!slot) {
      this.notify(cb, { status: 'expired' });
    } else if (slot.status !== 'pending') {
      this.notify(cb, { status: slot.status, ...(slot.reason ? { reason: slot.reason } : {}) });
    } else {
      slot.listeners.add(cb);
    }
  }

  get(flowId: string): Slot | undefined {
    return this.flows.get(flowId);
  }

  /** Abort every pending flow (host shutdown). */
  dispose(): void {
    for (const slot of [...this.flows.values()]) this.settle(slot, 'cancelled');
  }

  private notify(cb: (s: LoginSettlement) => void, s: LoginSettlement): void {
    try {
      cb(s);
    } catch (err) {
      this.logger.warn('mcp.oauth.login_listener_failed', {
        component: 'tools-mcp',
        event: 'mcp.oauth.login_listener_failed',
        err,
      });
    }
  }

  private emit(slot: Slot, outcome: LoginAuditEvent['outcome'], code?: string): void {
    const event: LoginAuditEvent = {
      server: slot.serverName,
      ...(slot.personalityId !== undefined ? { personalityId: slot.personalityId } : {}),
      flow: slot.kind,
      surface: slot.surface,
      ...(slot.authHost ? { authHost: slot.authHost } : {}),
      outcome,
      ...(code ? { code } : {}),
      ...(outcome !== 'started' && outcome !== 'refused'
        ? { polls: slot.polls, durationMs: this.now() - slot.startedAt }
        : {}),
    };
    this.logger.info('mcp.oauth.login', {
      component: 'tools-mcp',
      event: 'mcp.oauth.login',
      ...event,
    });
    this.recordEvent?.(event);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export interface McpLoginDeps {
  mcpJsonStore: McpJsonStore;
  secrets: SecretsResolver;
  mcpManager: Pick<McpManager, 'registerConfig' | 'reconnectPersonality'>;
  logger?: Logger;
  recordEvent?: (event: LoginAuditEvent) => void;
  /** Share one pending map between a McpDeviceLogin and a McpPasteLogin. Omitted: a private one. */
  slots?: LoginSlots;
}

type OAuth2Auth = Extract<NonNullable<McpServerConfig['auth']>, { type: 'oauth2' }>;

function scopedSecrets(secrets: SecretsResolver, personalityId?: string): SecretsResolver {
  return personalityId ? new PersonalityScopedSecrets(secrets, personalityId) : secrets;
}

function hostOf(url: string): string {
  return safeUrl(url)?.host ?? url;
}

function originOf(url: string): string | null {
  return safeUrl(url)?.origin ?? null;
}

async function loadOAuthEntry(
  store: McpJsonStore,
  serverName: string,
): Promise<{ config: McpServerConfig; auth: OAuth2Auth } | 'not_found' | 'not_oauth'> {
  const config = await store.get(serverName);
  if (!config) return 'not_found';
  if (config.auth?.type !== 'oauth2' || !config.url) return 'not_oauth';
  return { config, auth: config.auth };
}

/** Store the grant the way McpInstallFlow.complete does, then reconnect. A failed reconnect is non-fatal. */
async function persistGrant(
  d: McpLoginDeps,
  logger: Logger,
  input: {
    config: McpServerConfig;
    tokens: TokenSet;
    tokenEndpoint: string;
    issuer?: string;
    personalityId?: string;
  },
): Promise<void> {
  const serverName = input.config.name;
  await storeTokens(
    serverName,
    input.tokens,
    scopedSecrets(d.secrets, input.personalityId),
    bindingFor({
      token_endpoint: input.tokenEndpoint,
      ...(input.issuer !== undefined ? { issuer: input.issuer } : {}),
    }),
  );
  d.mcpManager.registerConfig(input.config);
  try {
    await d.mcpManager.reconnectPersonality(serverName, input.personalityId ?? '');
  } catch (err) {
    logger.warn('mcp.oauth.login_reconnect_failed', {
      component: 'tools-mcp',
      event: 'mcp.oauth.login_reconnect_failed',
      server: serverName,
      err,
    });
  }
}

// ---------------------------------------------------------------------------
// McpDeviceLogin
// ---------------------------------------------------------------------------

export interface McpDeviceLoginDeps extends McpLoginDeps {
  /** Injected I/O for the poller. Default: safeFetch + real clock. */
  deps?: DeviceFlowDeps;
  /** Used only when `slots` is omitted. */
  now?: () => number;
}

export class McpDeviceLogin {
  readonly slots: LoginSlots;
  private readonly d: McpLoginDeps;
  private readonly flowDeps: DeviceFlowDeps;
  private readonly logger: Logger;

  constructor(opts: McpDeviceLoginDeps) {
    this.d = opts;
    this.flowDeps = opts.deps ?? createDeviceFlowDeps();
    this.slots =
      opts.slots ??
      new LoginSlots({
        logger: opts.logger,
        recordEvent: opts.recordEvent,
        now: opts.now ?? this.flowDeps.now,
      });
    this.logger = this.slots.logger;
  }

  async start(input: StartLoginInput): Promise<StartDeviceResult> {
    const { serverName, personalityId, surface } = input;
    const entry = await loadOAuthEntry(this.d.mcpJsonStore, serverName);
    if (typeof entry === 'string') return { ok: false, code: entry };
    const { config, auth } = entry;

    const reserved = this.slots.reserve({ serverName, personalityId, surface, kind: 'device' });
    if (!reserved.ok) return { ok: false, code: reserved.code, detail: reserved.detail };
    const slot = reserved.slot;
    const refuse = (code: DeviceStartFailureCode, detail?: string): StartDeviceResult => {
      this.slots.refuse(slot, detail ? `${code}:${detail}` : code);
      return { ok: false, code, ...(detail ? { detail } : {}) };
    };

    try {
      const resolved = await this.resolveEndpoint(config, auth, personalityId);
      if ('refusal' in resolved) return refuse(resolved.refusal, resolved.detail);
      const { deviceEndpoint, issuer } = resolved;

      // D8: the device endpoint must share an origin with the token endpoint the grant will be bound to.
      const tokenOrigin = originOf(auth.token_endpoint);
      if (!tokenOrigin || originOf(deviceEndpoint) !== tokenOrigin) {
        return refuse('device_unavailable', 'origin_mismatch');
      }
      slot.authHost = hostOf(auth.token_endpoint);

      let authz: DeviceAuthorization;
      try {
        authz = await requestDeviceAuthorization(
          {
            deviceAuthorizationEndpoint: deviceEndpoint,
            clientId: auth.client_id,
            scopes: auth.scopes,
          },
          this.flowDeps,
          slot.abort.signal,
        );
      } catch (err) {
        if (err instanceof DeviceFlowBlockedError) return refuse('device_unavailable', 'blocked');
        if (err instanceof DeviceAuthorizationError) {
          return err.code === 'network_error'
            ? refuse('discovery_failed', 'network_error')
            : refuse('device_refused', err.code);
        }
        return refuse('device_refused', 'invalid_response');
      }

      this.slots.started(slot);
      void this.run(slot, config, auth, authz, issuer);
      return {
        ok: true,
        flowId: slot.flowId,
        userCode: authz.userCode,
        verificationUri: authz.verificationUri,
        ...(authz.verificationUriComplete
          ? { verificationUriComplete: authz.verificationUriComplete }
          : {}),
        expiresAt: authz.expiresAt,
        serverName,
        serverHost: hostOf(config.url ?? ''),
        authHost: slot.authHost,
        ...(personalityId !== undefined ? { personalityId } : {}),
      };
    } catch (err) {
      this.slots.refuse(slot, 'internal_error');
      this.logger.warn('mcp.oauth.login_start_failed', {
        component: 'tools-mcp',
        event: 'mcp.oauth.login_start_failed',
        server: serverName,
        err,
      });
      return { ok: false, code: 'device_refused', detail: 'internal_error' };
    }
  }

  status(flowId: string): LoginStatusResult {
    return this.slots.status(flowId);
  }

  cancel(flowId: string): void {
    this.slots.cancel(flowId);
  }

  onSettled(flowId: string, cb: (s: LoginSettlement) => void): void {
    this.slots.onSettled(flowId, cb);
  }

  dispose(): void {
    this.slots.dispose();
  }

  /** The stored endpoint, or (entries older than device sign-in) a one-off rediscovery that must agree with the stored token endpoint and binding. Never rewrites mcp.json (plan §4.2 item 5). */
  private async resolveEndpoint(
    config: McpServerConfig,
    auth: OAuth2Auth,
    personalityId?: string,
  ): Promise<
    | { deviceEndpoint: string; issuer?: string }
    | { refusal: 'device_unavailable' | 'discovery_failed'; detail?: string }
  > {
    if (auth.device_authorization_endpoint) {
      return {
        deviceEndpoint: auth.device_authorization_endpoint,
        ...(auth.issuer !== undefined ? { issuer: auth.issuer } : {}),
      };
    }
    let meta: Awaited<ReturnType<typeof discoverOAuthMetadata>>;
    try {
      meta = await discoverOAuthMetadata(config.url ?? '');
    } catch {
      return { refusal: 'discovery_failed' };
    }
    if (!meta.device_authorization_endpoint) return { refusal: 'device_unavailable' };
    if (hrefOf(meta.token_endpoint) !== hrefOf(auth.token_endpoint)) {
      return { refusal: 'device_unavailable', detail: 'token_endpoint_changed' };
    }
    const binding = await readBinding(config.name, scopedSecrets(this.d.secrets, personalityId));
    if (binding) {
      const issuerAgrees =
        binding.issuer === undefined || meta.issuer === undefined || binding.issuer === meta.issuer;
      if (hrefOf(binding.token_endpoint) !== hrefOf(meta.token_endpoint) || !issuerAgrees) {
        return { refusal: 'device_unavailable', detail: 'binding_mismatch' };
      }
    }
    return {
      deviceEndpoint: meta.device_authorization_endpoint,
      ...(meta.issuer !== undefined ? { issuer: meta.issuer } : {}),
    };
  }

  private async run(
    slot: Slot,
    config: McpServerConfig,
    auth: OAuth2Auth,
    authz: DeviceAuthorization,
    issuer: string | undefined,
  ): Promise<void> {
    try {
      const outcome = await pollDeviceToken(
        authz,
        {
          tokenEndpoint: auth.token_endpoint,
          clientId: auth.client_id,
          onPoll: () => {
            slot.polls++;
          },
        },
        this.flowDeps,
        slot.abort.signal,
      );
      if (outcome.kind === 'tokens') {
        try {
          await persistGrant(this.d, this.logger, {
            config,
            tokens: outcome.tokens,
            tokenEndpoint: auth.token_endpoint,
            issuer,
            personalityId: slot.personalityId,
          });
        } catch {
          this.slots.settle(slot, 'error', 'store_failed');
          return;
        }
        this.slots.settle(slot, 'connected');
      } else if (outcome.kind === 'error') {
        this.slots.settle(slot, 'error', outcome.code);
      } else {
        this.slots.settle(slot, outcome.kind);
      }
    } catch {
      this.slots.settle(slot, 'error', 'internal_error');
    }
  }
}

// ---------------------------------------------------------------------------
// McpPasteLogin
// ---------------------------------------------------------------------------

interface PasteSession {
  config: McpServerConfig;
  oauth: OAuthConfig;
  redirectUri: string;
  verifier: string;
  state: string;
  completing: boolean;
}

export class McpPasteLogin {
  readonly slots: LoginSlots;
  private readonly d: McpLoginDeps;
  private readonly sessions = new Map<string, PasteSession>();

  constructor(opts: McpLoginDeps & { now?: () => number }) {
    this.d = opts;
    this.slots =
      opts.slots ??
      new LoginSlots({ logger: opts.logger, recordEvent: opts.recordEvent, now: opts.now });
  }

  async start(input: StartLoginInput): Promise<StartPasteResult> {
    this.prune();
    const { serverName, personalityId, surface } = input;
    const entry = await loadOAuthEntry(this.d.mcpJsonStore, serverName);
    if (typeof entry === 'string') return { ok: false, code: entry };
    const { config, auth } = entry;

    const redirectUri = auth.dcr?.redirect_uri;
    if (!redirectUri || !isLoopbackRedirectUri(redirectUri)) {
      return {
        ok: false,
        code: 'paste_unavailable',
        detail: `'${serverName}' has no stored loopback redirect URI. Re-add it with: ethos mcp add ${serverName} --url <url>`,
      };
    }

    const expiresAt = this.slots.now() + PASTE_TTL_MS;
    const reserved = this.slots.reserve({
      serverName,
      personalityId,
      surface,
      kind: 'paste',
      expiresAt,
    });
    if (!reserved.ok) return { ok: false, code: reserved.code, detail: reserved.detail };
    const slot = reserved.slot;
    slot.authHost = hostOf(auth.token_endpoint);

    const oauth: OAuthConfig = {
      authorization_endpoint: auth.authorization_endpoint,
      token_endpoint: auth.token_endpoint,
      client_id: auth.client_id,
      ...(auth.scopes ? { scopes: auth.scopes } : {}),
      ...(auth.issuer !== undefined ? { issuer: auth.issuer } : {}),
      ...(auth.iss_parameter_supported !== undefined
        ? { iss_parameter_supported: auth.iss_parameter_supported }
        : {}),
    };
    const verifier = generateCodeVerifier();
    const state = randomBytes(16).toString('base64url');
    const authorizeUrl = buildAuthorizationUrl(
      oauth,
      redirectUri,
      state,
      generateCodeChallenge(verifier),
    );
    this.sessions.set(slot.flowId, {
      config,
      oauth,
      redirectUri,
      verifier,
      state,
      completing: false,
    });
    this.slots.started(slot);
    return {
      ok: true,
      flowId: slot.flowId,
      authorizeUrl,
      expiresAt,
      serverName,
      serverHost: hostOf(config.url ?? ''),
      authHost: slot.authHost,
      ...(personalityId !== undefined ? { personalityId } : {}),
    };
  }

  async complete(flowId: string, pasted: string): Promise<CompletePasteResult> {
    this.slots.sweep();
    this.prune();
    const slot = this.slots.get(flowId);
    const session = this.sessions.get(flowId);
    if (!slot || !session || slot.status !== 'pending' || session.completing) {
      return { ok: false, code: 'not_pending' };
    }

    // Check 1: the pasted address is the registered loopback redirect and carries a code.
    let parsed: ReturnType<typeof parsePastedRedirect>;
    try {
      parsed = parsePastedRedirect(pasted, { expectedRedirectUri: session.redirectUri });
    } catch (err) {
      if (err instanceof PastedRedirectError && err.code === 'access_denied') {
        this.finish(flowId, 'denied');
        return { ok: false, code: 'denied' };
      }
      if (err instanceof PastedRedirectError && err.code === 'provider_error') {
        this.finish(flowId, 'error', 'provider_error');
        return { ok: false, code: 'exchange_failed' };
      }
      return { ok: false, code: 'invalid_paste' }; // flow stays pending: a typo may be re-pasted
    }
    // Check 2: state is the one this flow issued. No token request on a mismatch.
    if (parsed.state !== session.state) return { ok: false, code: 'state_mismatch' };

    session.completing = true; // the code is single-use
    let tokens: TokenSet;
    try {
      // Check 3: exchangeCode runs checkAuthorizationResponseIssuer (RFC 9207) before any request.
      tokens = await exchangeCode(
        session.oauth,
        parsed.code,
        session.redirectUri,
        session.verifier,
        parsed.iss,
      );
    } catch (err) {
      if (err instanceof OAuthIssuerMismatch) {
        this.finish(flowId, 'error', 'issuer_mismatch');
        return { ok: false, code: 'issuer_mismatch' };
      }
      this.finish(flowId, 'error', 'exchange_failed');
      return { ok: false, code: 'exchange_failed' };
    }
    try {
      await persistGrant(this.d, this.slots.logger, {
        config: session.config,
        tokens,
        tokenEndpoint: session.oauth.token_endpoint,
        issuer: session.oauth.issuer,
        personalityId: slot.personalityId,
      });
    } catch {
      this.finish(flowId, 'error', 'store_failed');
      return { ok: false, code: 'store_failed' };
    }
    this.finish(flowId, 'connected');
    return { ok: true };
  }

  status(flowId: string): LoginStatusResult {
    return this.slots.status(flowId);
  }

  cancel(flowId: string): void {
    this.finish(flowId, 'cancelled');
  }

  onSettled(flowId: string, cb: (s: LoginSettlement) => void): void {
    this.slots.onSettled(flowId, cb);
  }

  dispose(): void {
    this.slots.dispose();
    this.sessions.clear();
  }

  /** Forget verifier/state of flows that settled elsewhere (sweep, slots.cancel, slots.dispose). */
  private prune(): void {
    for (const flowId of [...this.sessions.keys()]) {
      if (this.slots.get(flowId)?.status !== 'pending') this.sessions.delete(flowId);
    }
  }

  /** Settle and forget the verifier/state: a settled paste flow can never be completed. */
  private finish(flowId: string, status: LoginSettledStatus, reason?: string): void {
    const slot = this.slots.get(flowId);
    if (slot) this.slots.settle(slot, status, reason);
    this.sessions.delete(flowId);
  }
}
