// Tests for McpInstallFlow — the SDK install-flow state machine for UI-driven
// OAuth-based MCP server registration.
//
// Strategy:
//   - In-memory Storage + SecretsResolver fixtures from @ethosagent/storage-fs.
//   - Stub PersonalityRegistry — only `get` and `update` are exercised.
//   - Stub McpManager — only `addServer` and `listServers` are called.
//   - Mock globalThis.fetch for OAuth discovery + DCR + token-exchange calls.
//   - Injectable clock via the `now` constructor option for expiration tests.

import {
  InMemorySecretsResolver,
  type InMemorySecretsResolver as InMemorySecretsResolverType,
  InMemoryStorage,
} from '@ethosagent/storage-fs';
import type {
  McpServerInfo,
  PersonalityConfig,
  PersonalityRegistry,
  PersonalityRegistryPatch,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpInstallFlowOptions, McpServerConfig } from '../index';
import { McpInstallFlow, McpJsonStore, type McpManager } from '../index';
import { ConfidentialClientUnsupported, DcrUnsupported, OAuthDiscoveryError } from '../oauth';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MCP_URL = 'https://mcp.linear.app/sse';
const REDIRECT_URI = 'https://ethos.local/oauth/callback';
const MCP_JSON_PATH = '/home/test/.ethos/mcp.json';
const MCP_JSON_DIR = '/home/test/.ethos';
const PERSONALITY_ID = 'test-personality';

const DISCOVERY_OK = {
  authorization_endpoint: 'https://auth.linear.app/authorize',
  token_endpoint: 'https://auth.linear.app/token',
  registration_endpoint: 'https://auth.linear.app/register',
  revocation_endpoint: 'https://auth.linear.app/revoke',
  code_challenge_methods_supported: ['S256'],
};

const DCR_OK = {
  client_id: 'ethos-client-abc',
  client_id_issued_at: 1700000000,
};

const TOKEN_OK = {
  access_token: 'tok_access',
  refresh_token: 'tok_refresh',
  expires_in: 3600,
};

interface StubFetchScript {
  /** Map of url → either a fetch response or a function that produces one. */
  responders: Map<string, (req: { url: string; init?: RequestInit }) => Promise<Response>>;
  calls: { url: string; method?: string }[];
}

function makeFetchScript(): StubFetchScript {
  return { responders: new Map(), calls: [] };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetchStub(script: StubFetchScript): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    script.calls.push({ url, method: init?.method });
    const responder = script.responders.get(url);
    if (!responder) {
      return new Response('not found', { status: 404 });
    }
    return responder({ url, init });
  }) as typeof fetch;
}

function scriptHappyDiscoveryAndDcr(script: StubFetchScript): void {
  // Discovery: protected-resource is best-effort; if it 404s, the helper
  // falls back to the origin's `/.well-known/oauth-authorization-server`.
  script.responders.set(
    'https://mcp.linear.app/.well-known/oauth-protected-resource/sse',
    async () => new Response('not found', { status: 404 }),
  );
  script.responders.set('https://mcp.linear.app/.well-known/oauth-authorization-server', async () =>
    jsonResponse(DISCOVERY_OK),
  );
  script.responders.set(DISCOVERY_OK.registration_endpoint, async () => jsonResponse(DCR_OK, 201));
}

function scriptHappyTokenExchange(script: StubFetchScript): void {
  script.responders.set(DISCOVERY_OK.token_endpoint, async () => jsonResponse(TOKEN_OK));
}

// ---------------------------------------------------------------------------
// Stub McpManager — does NOT extend the real class (avoids spinning up real
// transports). We rely on the install-flow only touching `addServer` and
// `listServers`.
// ---------------------------------------------------------------------------

class StubMcpManager {
  readonly added: McpServerConfig[] = [];
  readonly registered: McpServerConfig[] = [];
  readonly reconnectCalls: { serverName: string; personalityId: string }[] = [];
  /** If set, the NEXT addServer call rejects with this error. */
  failNext?: Error;
  /** If set, the NEXT reconnectPersonality call rejects with this error. */
  failNextReconnect?: Error;
  /** Override the listServers return value. */
  serversToList: McpServerInfo[] = [];

  async addServer(config: McpServerConfig): Promise<void> {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = undefined;
      throw err;
    }
    this.added.push(config);
    this.serversToList = [
      ...this.serversToList,
      {
        name: config.name,
        transport: config.transport,
        ...(config.command !== undefined ? { command: config.command } : {}),
        ...(config.url !== undefined ? { url: config.url } : {}),
        ...(config.created_via !== undefined ? { created_via: config.created_via } : {}),
      },
    ];
  }

  registerConfig(config: McpServerConfig): void {
    this.registered.push(config);
  }

  async reconnectPersonality(serverName: string, personalityId: string): Promise<void> {
    this.reconnectCalls.push({ serverName, personalityId });
    if (this.failNextReconnect) {
      const err = this.failNextReconnect;
      this.failNextReconnect = undefined;
      throw err;
    }
  }

  listServers(): McpServerInfo[] {
    return [...this.serversToList];
  }

  // Methods the install-flow does not call but the type requires.
  async removeServer(): Promise<void> {
    throw new Error('not implemented in stub');
  }
}

// ---------------------------------------------------------------------------
// Stub PersonalityRegistry — minimal surface used by attachToPersonalities.
// ---------------------------------------------------------------------------

class StubPersonalityRegistry implements PersonalityRegistry {
  readonly personalities = new Map<string, PersonalityConfig>();
  /** If set, the next update for the matching id will reject with this error. */
  failOn = new Map<string, Error>();
  updateCalls: { id: string; patch: PersonalityRegistryPatch }[] = [];

  define(config: PersonalityConfig): void {
    this.personalities.set(config.id, config);
  }
  get(id: string): PersonalityConfig | undefined {
    return this.personalities.get(id);
  }
  list(): PersonalityConfig[] {
    return [...this.personalities.values()];
  }
  getDefault(): PersonalityConfig {
    const first = this.personalities.values().next().value;
    if (!first) throw new Error('no personalities');
    return first;
  }
  setDefault(): void {
    /* no-op */
  }
  async loadFromDirectory(): Promise<void> {
    /* no-op */
  }
  remove(id: string): void {
    this.personalities.delete(id);
  }
  async update(id: string, patch: PersonalityRegistryPatch): Promise<unknown> {
    this.updateCalls.push({ id, patch });
    const err = this.failOn.get(id);
    if (err) throw err;
    const existing = this.personalities.get(id);
    if (!existing) throw new Error(`unknown personality: ${id}`);
    const next: PersonalityConfig = { ...existing };
    if (patch.mcp_servers !== undefined) next.mcp_servers = patch.mcp_servers;
    if (patch.plugins !== undefined) next.plugins = patch.plugins;
    this.personalities.set(id, next);
    return { id };
  }
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Harness {
  storage: InMemoryStorage;
  secrets: InMemorySecretsResolverType;
  manager: StubMcpManager;
  registry: StubPersonalityRegistry;
  jsonStore: McpJsonStore;
  flow: McpInstallFlow;
  clock: { now: Date };
  script: StubFetchScript;
}

async function makeHarness(overrides: Partial<McpInstallFlowOptions> = {}): Promise<Harness> {
  const storage: InMemoryStorage = new InMemoryStorage();
  await storage.mkdir(MCP_JSON_DIR);
  const secrets = new InMemorySecretsResolver();
  const manager = new StubMcpManager();
  const registry = new StubPersonalityRegistry();
  const jsonStore = new McpJsonStore(storage, MCP_JSON_PATH);
  const clock = { now: new Date('2026-05-19T12:00:00.000Z') };
  const flow = new McpInstallFlow({
    mcpManager: manager as unknown as McpManager,
    secrets,
    personalityUpdater: registry,
    redirectUri: REDIRECT_URI,
    mcpJsonStore: jsonStore,
    now: () => clock.now,
    ...overrides,
  });
  const script = makeFetchScript();
  installFetchStub(script);
  return { storage, secrets, manager, registry, jsonStore, flow, clock, script };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

describe('McpInstallFlow.start', () => {
  it('happy path: discovery → DCR → placeholder mcp.json entry → pending session', async () => {
    const { flow, jsonStore, script, clock } = await makeHarness();
    scriptHappyDiscoveryAndDcr(script);

    const result = await flow.start({ mcpUrl: MCP_URL, personalityId: PERSONALITY_ID });

    expect(result.state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.state.length).toBeGreaterThan(40); // 32-byte base64url ≈ 43 chars
    expect(result.authorizeUrl).toContain(DISCOVERY_OK.authorization_endpoint);
    expect(result.authorizeUrl).toContain(`state=${result.state}`);
    expect(result.authorizeUrl).toContain(`client_id=${DCR_OK.client_id}`);
    expect(result.authorizeUrl).toContain('code_challenge_method=S256');
    expect(result.serverName).toBe('linear');
    // expiresAt is relative to the injected clock, not wall-clock.
    expect(result.expiresAt.getTime()).toBeGreaterThan(clock.now.getTime());

    const persisted = await jsonStore.get('linear');
    expect(persisted).toMatchObject({
      name: 'linear',
      transport: 'streamable-http',
      url: MCP_URL,
      created_via: 'ui',
      auth: {
        type: 'oauth2',
        client_id: DCR_OK.client_id,
        authorization_endpoint: DISCOVERY_OK.authorization_endpoint,
        token_endpoint: DISCOVERY_OK.token_endpoint,
        revocation_endpoint: DISCOVERY_OK.revocation_endpoint,
        dcr: {
          registration_endpoint: DISCOVERY_OK.registration_endpoint,
          client_id_issued_at: DCR_OK.client_id_issued_at,
        },
      },
    });

    expect(flow.getStatus(result.state)).toBe('pending');
  });

  it('uses an explicit name argument when supplied', async () => {
    const { flow, script } = await makeHarness();
    scriptHappyDiscoveryAndDcr(script);

    const result = await flow.start({
      mcpUrl: MCP_URL,
      name: 'custom',
      personalityId: PERSONALITY_ID,
    });
    expect(result.serverName).toBe('custom');
  });

  it('OAuthDiscoveryError propagates; no placeholder written, no pending session', async () => {
    const { flow, jsonStore } = await makeHarness();
    // No discovery responders → all 404 → discovery fails.
    await expect(
      flow.start({ mcpUrl: MCP_URL, personalityId: PERSONALITY_ID }),
    ).rejects.toBeInstanceOf(OAuthDiscoveryError);

    expect(await jsonStore.list()).toEqual([]);
    // Pending map is empty; an unknown state returns 'expired'.
    expect(flow.getStatus('anything')).toBe('expired');
  });

  it('DcrUnsupported when registration_endpoint is missing; no placeholder', async () => {
    const { flow, jsonStore, script } = await makeHarness();
    script.responders.set(
      'https://mcp.linear.app/.well-known/oauth-protected-resource/sse',
      async () => new Response('nope', { status: 404 }),
    );
    script.responders.set(
      'https://mcp.linear.app/.well-known/oauth-authorization-server',
      async () => {
        const { registration_endpoint: _omit, ...without } = DISCOVERY_OK;
        return jsonResponse(without);
      },
    );

    await expect(
      flow.start({ mcpUrl: MCP_URL, personalityId: PERSONALITY_ID }),
    ).rejects.toBeInstanceOf(DcrUnsupported);
    expect(await jsonStore.list()).toEqual([]);
  });

  it('ConfidentialClientUnsupported when DCR returns a client_secret; no placeholder', async () => {
    const { flow, jsonStore, script } = await makeHarness();
    script.responders.set(
      'https://mcp.linear.app/.well-known/oauth-protected-resource/sse',
      async () => new Response('nope', { status: 404 }),
    );
    script.responders.set(
      'https://mcp.linear.app/.well-known/oauth-authorization-server',
      async () => jsonResponse(DISCOVERY_OK),
    );
    script.responders.set(DISCOVERY_OK.registration_endpoint, async () =>
      jsonResponse({ ...DCR_OK, client_secret: 'shh' }, 201),
    );

    await expect(
      flow.start({ mcpUrl: MCP_URL, personalityId: PERSONALITY_ID }),
    ).rejects.toBeInstanceOf(ConfidentialClientUnsupported);
    expect(await jsonStore.list()).toEqual([]);
  });

  it('rejects when the derived name collides with an existing mcp.json entry', async () => {
    const { flow, jsonStore, script } = await makeHarness();
    await jsonStore.upsert('linear', { name: 'linear', transport: 'stdio', command: 'x' });
    scriptHappyDiscoveryAndDcr(script);

    await expect(
      flow.start({ mcpUrl: MCP_URL, personalityId: PERSONALITY_ID }),
    ).rejects.toMatchObject({
      name: 'EthosError',
      code: 'INVALID_INPUT',
    });
    // The pre-existing entry was NOT touched.
    expect(await jsonStore.get('linear')).toEqual({
      name: 'linear',
      transport: 'stdio',
      command: 'x',
    });
  });

  it('per-flow redirectUri overrides the constructor default in DCR + authorize URL', async () => {
    const { flow, script } = await makeHarness();
    // Wire discovery + an instrumented DCR responder that captures the
    // request body so we can assert on `redirect_uris`.
    script.responders.set(
      'https://mcp.linear.app/.well-known/oauth-protected-resource/sse',
      async () => new Response('not found', { status: 404 }),
    );
    script.responders.set(
      'https://mcp.linear.app/.well-known/oauth-authorization-server',
      async () => jsonResponse(DISCOVERY_OK),
    );
    let capturedDcrBody: { redirect_uris?: string[] } | undefined;
    script.responders.set(DISCOVERY_OK.registration_endpoint, async ({ init }) => {
      const raw = typeof init?.body === 'string' ? init.body : '';
      capturedDcrBody = raw ? (JSON.parse(raw) as { redirect_uris?: string[] }) : undefined;
      return jsonResponse(DCR_OK, 201);
    });

    const flowRedirect = 'http://192.168.1.50:5173/oauth/callback';
    const result = await flow.start({
      mcpUrl: MCP_URL,
      personalityId: PERSONALITY_ID,
      redirectUri: flowRedirect,
    });

    // Authorize URL uses the per-flow URI, NOT REDIRECT_URI.
    const authUrl = new URL(result.authorizeUrl);
    expect(authUrl.searchParams.get('redirect_uri')).toBe(flowRedirect);

    // DCR registered exactly that URI as the sole entry.
    expect(capturedDcrBody?.redirect_uris).toEqual([flowRedirect]);
  });
});

// ---------------------------------------------------------------------------
// complete()
// ---------------------------------------------------------------------------

describe('McpInstallFlow.complete', () => {
  it('happy path: token exchange + storeTokens + addServer; status → connected', async () => {
    const { flow, manager, secrets, script } = await makeHarness();
    scriptHappyDiscoveryAndDcr(script);
    const { state, serverName } = await flow.start({
      mcpUrl: MCP_URL,
      personalityId: PERSONALITY_ID,
    });

    scriptHappyTokenExchange(script);
    const result = await flow.complete({ code: 'auth-code-123', state });

    expect(result.serverName).toBe(serverName);
    expect(manager.registered).toHaveLength(1);
    expect(manager.registered[0]).toMatchObject({
      name: 'linear',
      transport: 'streamable-http',
      url: MCP_URL,
      created_via: 'ui',
    });
    // Tokens are stored under the personality-scoped path.
    const prefix = `personalities/${PERSONALITY_ID}`;
    expect(await secrets.get(`${prefix}/mcp/${serverName}/access_token`)).toBe(
      TOKEN_OK.access_token,
    );
    expect(await secrets.get(`${prefix}/mcp/${serverName}/refresh_token`)).toBe(
      TOKEN_OK.refresh_token,
    );
    expect(flow.getStatus(state)).toBe('connected');
  });

  it('NOT_FOUND for an unknown state', async () => {
    const { flow } = await makeHarness();
    await expect(flow.complete({ code: 'x', state: 'no-such-state' })).rejects.toMatchObject({
      name: 'EthosError',
      code: 'NOT_FOUND',
    });
  });

  it('rolls back placeholder + drops session when token exchange fails', async () => {
    const { flow, manager, jsonStore, secrets, script } = await makeHarness();
    scriptHappyDiscoveryAndDcr(script);
    const { state, serverName } = await flow.start({
      mcpUrl: MCP_URL,
      personalityId: PERSONALITY_ID,
    });

    script.responders.set(
      DISCOVERY_OK.token_endpoint,
      async () => new Response('bad code', { status: 400 }),
    );

    await expect(flow.complete({ code: 'bad', state })).rejects.toThrow(/Token exchange failed/);
    expect(manager.added).toHaveLength(0);
    expect(await jsonStore.get(serverName)).toBeNull();
    const prefix = `personalities/${PERSONALITY_ID}`;
    expect(await secrets.get(`${prefix}/mcp/${serverName}/access_token`)).toBeNull();
    expect(flow.getStatus(state)).toBe('expired');
  });

  it('rolls back placeholder + tokens when secrets.set throws', async () => {
    const failingSecrets = new InMemorySecretsResolver();
    let firstSet = true;
    const origSet = failingSecrets.set.bind(failingSecrets);
    failingSecrets.set = vi.fn(async (ref: string, value: string) => {
      if (firstSet) {
        firstSet = false;
        return origSet(ref, value); // access_token lands
      }
      throw new Error('secrets backend down');
    }) as typeof failingSecrets.set;

    const storage = new InMemoryStorage();
    await storage.mkdir(MCP_JSON_DIR);
    const manager = new StubMcpManager();
    const registry = new StubPersonalityRegistry();
    const jsonStore = new McpJsonStore(storage, MCP_JSON_PATH);
    const flow = new McpInstallFlow({
      mcpManager: manager as unknown as McpManager,
      secrets: failingSecrets,
      personalityUpdater: registry,
      redirectUri: REDIRECT_URI,
      mcpJsonStore: jsonStore,
    });
    const script = makeFetchScript();
    installFetchStub(script);
    scriptHappyDiscoveryAndDcr(script);

    const { state, serverName } = await flow.start({
      mcpUrl: MCP_URL,
      personalityId: PERSONALITY_ID,
    });

    scriptHappyTokenExchange(script);

    await expect(flow.complete({ code: 'auth-code', state })).rejects.toThrow(
      /secrets backend down/,
    );
    expect(manager.added).toHaveLength(0);
    expect(await jsonStore.get(serverName)).toBeNull();
    const prefix = `personalities/${PERSONALITY_ID}`;
    expect(await failingSecrets.get(`${prefix}/mcp/${serverName}/access_token`)).toBeNull();
  });

  it('personality path: reconnect failure is non-fatal — tokens and config are preserved', async () => {
    const { flow, manager, jsonStore, secrets, script } = await makeHarness();
    scriptHappyDiscoveryAndDcr(script);
    const { state, serverName } = await flow.start({
      mcpUrl: MCP_URL,
      personalityId: PERSONALITY_ID,
    });

    scriptHappyTokenExchange(script);
    manager.failNextReconnect = new Error('mcp connect failed');

    // Should NOT throw — reconnect failure is non-fatal for personality path.
    const result = await flow.complete({ code: 'auth-code', state });
    expect(result.serverName).toBe(serverName);

    // Config was registered (not added via addServer).
    expect(manager.added).toHaveLength(0);
    expect(manager.registered).toHaveLength(1);
    expect(manager.reconnectCalls).toHaveLength(1);

    // Tokens are preserved.
    const prefix = `personalities/${PERSONALITY_ID}`;
    expect(await secrets.get(`${prefix}/mcp/${serverName}/access_token`)).toBe(TOKEN_OK.access_token);
    expect(await secrets.get(`${prefix}/mcp/${serverName}/refresh_token`)).toBe(TOKEN_OK.refresh_token);

    // mcp.json config is preserved.
    expect(await jsonStore.get(serverName)).not.toBeNull();
    expect(flow.getStatus(state)).toBe('connected');
  });

  it('non-personality path: rolls back tokens + placeholder when addServer fails', async () => {
    const { flow, manager, jsonStore, secrets, script } = await makeHarness();
    scriptHappyDiscoveryAndDcr(script);
    // No personalityId — uses the global-secrets addServer path.
    const { state, serverName } = await flow.start({ mcpUrl: MCP_URL });

    scriptHappyTokenExchange(script);
    manager.failNext = new Error('mcp connect failed');

    await expect(flow.complete({ code: 'auth-code', state })).rejects.toThrow(/mcp connect failed/);

    expect(manager.added).toHaveLength(0);
    expect(await jsonStore.get(serverName)).toBeNull();
    // Global path: tokens stored without personality prefix.
    expect(await secrets.get(`mcp/${serverName}/access_token`)).toBeNull();
    expect(await secrets.get(`mcp/${serverName}/refresh_token`)).toBeNull();
  });

  it('exchanges the code against the per-flow redirectUri persisted on the session', async () => {
    const { flow, script } = await makeHarness();
    scriptHappyDiscoveryAndDcr(script);

    const flowRedirect = 'http://localhost:5173/oauth/callback';
    const { state } = await flow.start({
      mcpUrl: MCP_URL,
      personalityId: PERSONALITY_ID,
      redirectUri: flowRedirect,
    });

    // Instrument the token endpoint to capture the form body.
    let capturedTokenForm: URLSearchParams | undefined;
    script.responders.set(DISCOVERY_OK.token_endpoint, async ({ init }) => {
      const raw = typeof init?.body === 'string' ? init.body : '';
      capturedTokenForm = new URLSearchParams(raw);
      return jsonResponse(TOKEN_OK);
    });

    await flow.complete({ code: 'auth-code', state });

    // exchangeCode passes redirect_uri as a form field; it MUST match the
    // per-flow URI, not the constructor default.
    expect(capturedTokenForm?.get('redirect_uri')).toBe(flowRedirect);
  });

  it('rejects when the session has already completed', async () => {
    const { flow, script } = await makeHarness();
    scriptHappyDiscoveryAndDcr(script);
    const { state } = await flow.start({ mcpUrl: MCP_URL, personalityId: PERSONALITY_ID });
    scriptHappyTokenExchange(script);
    await flow.complete({ code: 'auth', state });

    await expect(flow.complete({ code: 'auth', state })).rejects.toMatchObject({
      name: 'EthosError',
      code: 'INVALID_INPUT',
    });
  });

  it('stores tokens at the personality-scoped path, not the global path', async () => {
    const { flow, secrets, script } = await makeHarness();
    scriptHappyDiscoveryAndDcr(script);
    const pid = 'researcher';
    const { state, serverName } = await flow.start({
      mcpUrl: MCP_URL,
      personalityId: pid,
    });
    scriptHappyTokenExchange(script);
    await flow.complete({ code: 'auth-code', state });

    // Scoped path must contain the token.
    expect(await secrets.get(`personalities/${pid}/mcp/${serverName}/access_token`)).toBe(
      TOKEN_OK.access_token,
    );
    // Global (unscoped) path must NOT contain the token.
    expect(await secrets.get(`mcp/${serverName}/access_token`)).toBeNull();
  });

  it('different personalityIds produce isolated token namespaces', async () => {
    const { secrets, script, manager, registry, jsonStore, clock } = await makeHarness();

    // Flow for personality "alpha"
    const flowAlpha = new McpInstallFlow({
      mcpManager: manager as unknown as McpManager,
      secrets,
      personalityUpdater: registry,
      redirectUri: REDIRECT_URI,
      mcpJsonStore: jsonStore,
      now: () => clock.now,
    });
    scriptHappyDiscoveryAndDcr(script);
    const rAlpha = await flowAlpha.start({
      mcpUrl: MCP_URL,
      name: 'linear-a',
      personalityId: 'alpha',
    });
    scriptHappyTokenExchange(script);
    await flowAlpha.complete({ code: 'code-a', state: rAlpha.state });

    // Remove mcp.json entry so second start with a new name won't collide.
    await jsonStore.remove('linear-a');

    // Flow for personality "beta"
    const flowBeta = new McpInstallFlow({
      mcpManager: manager as unknown as McpManager,
      secrets,
      personalityUpdater: registry,
      redirectUri: REDIRECT_URI,
      mcpJsonStore: jsonStore,
      now: () => clock.now,
    });
    scriptHappyDiscoveryAndDcr(script);
    const rBeta = await flowBeta.start({
      mcpUrl: MCP_URL,
      name: 'linear-b',
      personalityId: 'beta',
    });
    scriptHappyTokenExchange(script);
    await flowBeta.complete({ code: 'code-b', state: rBeta.state });

    // Both scoped paths should have tokens.
    expect(await secrets.get(`personalities/alpha/mcp/${rAlpha.serverName}/access_token`)).toBe(
      TOKEN_OK.access_token,
    );
    expect(await secrets.get(`personalities/beta/mcp/${rBeta.serverName}/access_token`)).toBe(
      TOKEN_OK.access_token,
    );

    // They should be independent (one deletion doesn't affect the other).
    await secrets.delete(`personalities/alpha/mcp/${rAlpha.serverName}/access_token`);
    expect(await secrets.get(`personalities/beta/mcp/${rBeta.serverName}/access_token`)).toBe(
      TOKEN_OK.access_token,
    );
  });
});

// ---------------------------------------------------------------------------
// cancel()
// ---------------------------------------------------------------------------

describe('McpInstallFlow.cancel', () => {
  it('rolls back the placeholder and drops the pending session', async () => {
    const { flow, jsonStore, script } = await makeHarness();
    scriptHappyDiscoveryAndDcr(script);
    const { state, serverName } = await flow.start({
      mcpUrl: MCP_URL,
      personalityId: PERSONALITY_ID,
    });

    expect(await jsonStore.get(serverName)).not.toBeNull();
    await flow.cancel(state);

    expect(await jsonStore.get(serverName)).toBeNull();
    expect(flow.getStatus(state)).toBe('expired');
  });

  it('no-op for an unknown state', async () => {
    const { flow } = await makeHarness();
    await expect(flow.cancel('does-not-exist')).resolves.toBeUndefined();
  });

  it('does NOT roll back the placeholder for a connected session', async () => {
    const { flow, jsonStore, script } = await makeHarness();
    scriptHappyDiscoveryAndDcr(script);
    const { state, serverName } = await flow.start({
      mcpUrl: MCP_URL,
      personalityId: PERSONALITY_ID,
    });
    scriptHappyTokenExchange(script);
    await flow.complete({ code: 'auth', state });

    await flow.cancel(state);
    // The connected server's entry is still in mcp.json — the operator
    // chose to keep it.
    expect(await jsonStore.get(serverName)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getStatus() — lifecycle + retention windows
// ---------------------------------------------------------------------------

describe('McpInstallFlow.getStatus', () => {
  it("returns 'expired' for unknown state", async () => {
    const { flow } = await makeHarness();
    expect(flow.getStatus('nope')).toBe('expired');
  });

  it("'pending' immediately after start; 'connected' after complete", async () => {
    const { flow, script } = await makeHarness();
    scriptHappyDiscoveryAndDcr(script);
    const { state } = await flow.start({ mcpUrl: MCP_URL, personalityId: PERSONALITY_ID });

    expect(flow.getStatus(state)).toBe('pending');

    scriptHappyTokenExchange(script);
    await flow.complete({ code: 'auth', state });
    expect(flow.getStatus(state)).toBe('connected');
  });

  it("drops a terminal session after terminalRetentionMs elapses → 'expired'", async () => {
    const { flow, clock, script } = await makeHarness({ terminalRetentionMs: 5_000 });
    scriptHappyDiscoveryAndDcr(script);
    const { state } = await flow.start({ mcpUrl: MCP_URL, personalityId: PERSONALITY_ID });
    scriptHappyTokenExchange(script);
    await flow.complete({ code: 'auth', state });

    expect(flow.getStatus(state)).toBe('connected');
    // Advance the clock past the retention window.
    clock.now = new Date(clock.now.getTime() + 6_000);
    expect(flow.getStatus(state)).toBe('expired');
  });

  it('eager-on-touch sweep drops expired pending sessions', async () => {
    const { flow, clock, script } = await makeHarness({ pendingTtlMs: 1_000 });
    scriptHappyDiscoveryAndDcr(script);
    const { state } = await flow.start({ mcpUrl: MCP_URL, personalityId: PERSONALITY_ID });

    clock.now = new Date(clock.now.getTime() + 2_000);
    // Any method call triggers the sweep.
    expect(flow.getStatus(state)).toBe('expired');
  });
});

// ---------------------------------------------------------------------------
// attachToPersonalities()
// ---------------------------------------------------------------------------

describe('McpInstallFlow.attachToPersonalities', () => {
  function seedPersonalities(reg: StubPersonalityRegistry): void {
    reg.define({ id: 'p1', name: 'P1' });
    reg.define({ id: 'p2', name: 'P2', mcp_servers: ['existing'] });
    reg.define({ id: 'p3', name: 'P3' });
  }

  it('updates all matching personalities and returns them in `updated`', async () => {
    const { flow, registry } = await makeHarness();
    seedPersonalities(registry);

    const result = await flow.attachToPersonalities({
      serverName: 'linear',
      personalityIds: ['p1', 'p2', 'p3'],
    });

    expect(result.updated.sort()).toEqual(['p1', 'p2', 'p3']);
    expect(result.failed).toEqual([]);
    expect(registry.personalities.get('p1')?.mcp_servers).toEqual(['linear']);
    expect(registry.personalities.get('p2')?.mcp_servers).toEqual(['existing', 'linear']);
    expect(registry.personalities.get('p3')?.mcp_servers).toEqual(['linear']);
  });

  it('partial failure: collects per-id errors without aborting the batch', async () => {
    const { flow, registry } = await makeHarness();
    seedPersonalities(registry);
    registry.failOn.set('p2', new Error('disk full'));

    const result = await flow.attachToPersonalities({
      serverName: 'linear',
      personalityIds: ['p1', 'p2', 'p3'],
    });

    expect(result.updated.sort()).toEqual(['p1', 'p3']);
    expect(result.failed).toEqual([{ id: 'p2', error: 'disk full' }]);
    expect(registry.personalities.get('p1')?.mcp_servers).toEqual(['linear']);
    expect(registry.personalities.get('p3')?.mcp_servers).toEqual(['linear']);
  });

  it('idempotent: server already present in mcp_servers is not duplicated', async () => {
    const { flow, registry } = await makeHarness();
    registry.define({ id: 'p1', name: 'P1', mcp_servers: ['linear', 'github'] });

    const result = await flow.attachToPersonalities({
      serverName: 'linear',
      personalityIds: ['p1'],
    });

    expect(result.updated).toEqual(['p1']);
    expect(result.failed).toEqual([]);
    expect(registry.personalities.get('p1')?.mcp_servers).toEqual(['linear', 'github']);
    // Update was NOT called (idempotent short-circuit).
    expect(registry.updateCalls).toHaveLength(0);
  });

  it('reports unknown personalities in `failed`', async () => {
    const { flow, registry } = await makeHarness();
    registry.define({ id: 'p1', name: 'P1' });

    const result = await flow.attachToPersonalities({
      serverName: 'linear',
      personalityIds: ['p1', 'ghost'],
    });
    expect(result.updated).toEqual(['p1']);
    expect(result.failed).toEqual([{ id: 'ghost', error: "Personality 'ghost' not found" }]);
  });
});

// ---------------------------------------------------------------------------
// listServers() — pass-through
// ---------------------------------------------------------------------------

describe('McpInstallFlow.listServers', () => {
  it('delegates to the McpManager and returns the snapshot', async () => {
    const { flow, manager } = await makeHarness();
    manager.serversToList = [
      { name: 'a', transport: 'stdio', command: 'cmd' },
      { name: 'b', transport: 'streamable-http', url: 'https://b' },
    ];

    expect(flow.listServers()).toEqual([
      { name: 'a', transport: 'stdio', command: 'cmd' },
      { name: 'b', transport: 'streamable-http', url: 'https://b' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Re-use of harness fixtures across the describe blocks above kept the same
// fetch stub installed; reset between tests via the global afterEach.
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Per-test fresh state happens inside makeHarness; this just keeps the
  // afterEach symmetry obvious.
});
