import { SsrfError, validateUrl } from '@ethosagent/core';
import { PersonalityScopedSecrets } from '@ethosagent/storage-fs';
import {
  ConfidentialClientUnsupported,
  DcrUnsupported,
  deleteTokens,
  McpInstallFlow,
  OAuthDiscoveryError,
  revokeToken,
} from '@ethosagent/tools-mcp';
export class McpService {
  flow;
  mcpJsonStore;
  mcpManager;
  personalityUpdater;
  secrets;
  constructor(opts) {
    this.mcpJsonStore = opts.mcpJsonStore;
    this.mcpManager = opts.mcpManager;
    this.personalityUpdater = opts.personalityUpdater;
    this.secrets = opts.secrets;
    this.flow = new McpInstallFlow({
      mcpManager: opts.mcpManager,
      personalityUpdater: opts.personalityUpdater,
      secrets: opts.secrets,
      mcpJsonStore: opts.mcpJsonStore,
      redirectUri: opts.redirectUri,
    });
  }
  async start(input, redirectUri) {
    try {
      validateUrl(input.url, { allowLocalhost: true });
    } catch (err) {
      const detail =
        err instanceof SsrfError ? err.message : 'URL points to a private or reserved IP range';
      return { ok: false, code: 'ssrf_blocked', detail };
    }
    try {
      // Prefer the per-flow `redirectUri` (derived from the web request's
      // Origin in routes/rpc.ts). When the caller doesn't supply one (e.g.
      // tests, server-to-server, or a request with no Origin and a
      // non-allowlisted host), `flow.start` falls back to the
      // constructor-level default.
      const startOpts = { mcpUrl: input.url };
      if (input.personalityId !== undefined) startOpts.personalityId = input.personalityId;
      if (input.name !== undefined) startOpts.name = input.name;
      if (redirectUri !== undefined) startOpts.redirectUri = redirectUri;
      const result = await this.flow.start(startOpts);
      return {
        ok: true,
        state: result.state,
        authorizeUrl: result.authorizeUrl,
        serverName: result.serverName,
      };
    } catch (err) {
      if (err instanceof OAuthDiscoveryError) {
        return { ok: false, code: 'discovery_failed', detail: err.message };
      }
      if (err instanceof DcrUnsupported) {
        return { ok: false, code: 'dcr_unsupported', detail: err.message };
      }
      if (err instanceof ConfidentialClientUnsupported) {
        return { ok: false, code: 'dcr_failed', detail: err.message };
      }
      // McpInstallFlow uses EthosError with a stable `kind` discriminator in
      // `details` to indicate which UI error code to surface. Keep this in
      // sync with the discriminators set by install-flow.ts.
      const coded = err;
      const kind = coded.details?.kind;
      if (kind === 'name_taken' || coded.code === 'name_taken') {
        return { ok: false, code: 'name_taken', detail: coded.message };
      }
      return {
        ok: false,
        code: 'discovery_failed',
        detail: coded.message ?? 'Unknown error',
      };
    }
  }
  async complete(input, cookieState) {
    // CSRF check: the pending cookie must match the state from the input.
    if (!cookieState) {
      return {
        ok: false,
        code: 'missing_pending_cookie',
        detail: 'OAuth session expired — please retry from the UI.',
      };
    }
    if (cookieState !== input.state) {
      return {
        ok: false,
        code: 'state_mismatch',
        detail: 'OAuth state mismatch — possible CSRF.',
      };
    }
    if (input.error) {
      return { ok: false, code: 'upstream_error', detail: input.error };
    }
    if (!input.code) {
      return {
        ok: false,
        code: 'code_exchange_failed',
        detail: 'Missing authorization code',
      };
    }
    try {
      const result = await this.flow.complete({ code: input.code, state: input.state });
      return { ok: true, serverName: result.serverName };
    } catch (err) {
      const coded = err;
      const kind = coded.details?.kind ?? coded.code;
      const code =
        kind === 'expired_state' || kind === 'already_completed'
          ? 'expired_state'
          : 'code_exchange_failed';
      return { ok: false, code, detail: coded.message };
    }
  }
  status(cookieState) {
    if (!cookieState) return { status: 'expired' };
    return this.getStatus(cookieState);
  }
  getStatus(state) {
    return { status: this.flow.getStatus(state) };
  }
  async cancel(state) {
    await this.flow.cancel(state);
    return { ok: true };
  }
  async attachPersonalities(input) {
    return this.flow.attachToPersonalities(input);
  }
  async list() {
    const configs = await this.mcpJsonStore.read();
    const servers = await Promise.all(
      configs.map(async (c) => {
        const authStatus = await this.computeAuthStatus(c.name, this.secrets, c);
        return {
          name: c.name,
          transport: c.transport,
          command: typeof c.command === 'string' ? c.command : null,
          url: typeof c.url === 'string' ? c.url : null,
          auth_status: authStatus,
          created_via: c.created_via ?? null,
          mcpResultLimitChars: c.mcpResultLimitChars ?? null,
          deprecated: c.transport === 'sse',
        };
      }),
    );
    return { servers };
  }
  async personalityServers(input) {
    const personality = this.personalityUpdater.get(input.personalityId);
    if (!personality) return { servers: [] };
    const mcpServers = personality.mcp_servers ?? [];
    const scopedSecrets = new PersonalityScopedSecrets(this.secrets, input.personalityId);
    const configs = await this.mcpJsonStore.read();
    const servers = await Promise.all(
      mcpServers.map(async (name) => {
        const config = configs.find((c) => c.name === name);
        const raw = await this.computeAuthStatus(name, scopedSecrets, config);
        // Non-OAuth servers are always accessible — map 'none' to 'authorized'.
        const authStatus = raw === 'none' ? 'authorized' : raw;
        return {
          name,
          transport: config?.transport,
          url: typeof config?.url === 'string' ? config.url : undefined,
          auth_status: authStatus,
        };
      }),
    );
    return { servers };
  }
  async addServer(input) {
    if (input.transport === 'stdio') {
      return {
        ok: false,
        code: 'invalid_url',
        detail:
          'Stdio transport cannot be added via the web API. Use the CLI: ethos mcp add --stdio',
      };
    }
    if (!input.url) {
      return {
        ok: false,
        code: 'invalid_url',
        detail: 'URL is required for HTTP transports',
      };
    }
    try {
      validateUrl(input.url, { allowLocalhost: true });
    } catch (err) {
      const detail =
        err instanceof SsrfError ? err.message : 'URL points to a private or reserved IP range';
      return { ok: false, code: 'ssrf_blocked', detail };
    }
    const existing = await this.mcpJsonStore.get(input.name);
    if (existing) {
      return {
        ok: false,
        code: 'name_taken',
        detail: `Server '${input.name}' already exists`,
      };
    }
    const config = {
      name: input.name,
      transport: input.transport,
      url: input.url,
      created_via: 'ui',
      ...(input.token ? { auth: { type: 'bearer' } } : {}),
      ...(input.mcpResultLimitChars !== undefined
        ? { mcpResultLimitChars: input.mcpResultLimitChars }
        : {}),
    };
    await this.mcpJsonStore.upsert(input.name, config);
    if (input.token) {
      await this.secrets.set(`mcp/${input.name}/access_token`, input.token);
    }
    return { ok: true, serverName: input.name };
  }
  async delete(input) {
    // Read config before removing so we can revoke tokens
    const configs = await this.mcpJsonStore.read();
    const config = configs.find((c) => c.name === input.name);
    // Revoke + delete tokens if the server had OAuth auth
    if (config?.auth?.type === 'oauth2') {
      const oauthConfig = {
        authorization_endpoint: config.auth.authorization_endpoint,
        token_endpoint: config.auth.token_endpoint,
        client_id: config.auth.client_id,
        scopes: config.auth.scopes,
        revocation_endpoint: config.auth.revocation_endpoint,
      };
      await revokeToken(input.name, oauthConfig, this.secrets).catch(() => {});
      await deleteTokens(input.name, this.secrets).catch(() => {});
    }
    // Remove from manager
    try {
      await this.mcpManager.removeServer(input.name);
    } catch {
      // Server might not be registered (e.g. stdio server not started)
    }
    // Remove from mcp.json
    await this.mcpJsonStore.remove(input.name);
    return { ok: true };
  }
  /**
   * List the tools a given MCP server exposes, for the personality editor's
   * per-server tool checklist. Tool names are returned BARE (the
   * `mcp__<server>__` prefix is stripped) because `mcp.yaml` stores bare
   * names.
   *
   * Discovery runs under `personalityId` because OAuth credentials are
   * scoped per personality. When the server is unreachable (not connected /
   * no credentials), `getToolsForPersonality` swallows the per-server
   * failure and yields no tools — this returns `{ available: false }` so
   * the UI can show a note instead of an empty checklist.
   */
  async serverTools(input) {
    const prefix = `mcp__${input.serverName}__`;
    let all;
    try {
      all = await this.mcpManager.getToolsForPersonality(input.personalityId);
    } catch {
      return { available: false, tools: [], nextCursor: null };
    }
    const tools = all
      .filter((t) => t.name.startsWith(prefix))
      .map((t) => {
        const bare = t.name.slice(prefix.length);
        return t.description && t.description !== bare
          ? { name: bare, description: t.description }
          : { name: bare };
      });
    const pageSize = input.limit ?? 50;
    const startIdx = input.cursor ? parseInt(input.cursor, 10) : 0;
    const page = tools.slice(startIdx, startIdx + pageSize);
    const nextIdx = startIdx + pageSize;
    const nextCursor = nextIdx < tools.length ? String(nextIdx) : null;
    return { available: tools.length > 0, tools: page, nextCursor };
  }
  async refreshToken(input) {
    const configs = await this.mcpJsonStore.read();
    const config = configs.find((c) => c.name === input.serverName);
    if (!config?.auth || config.auth.type !== 'oauth2') {
      return { ok: false, expiresAt: null, error: 'Server does not use OAuth2 auth' };
    }
    try {
      const { refreshToken: doRefresh } = await import('@ethosagent/tools-mcp');
      await doRefresh(input.serverName, config.auth, this.secrets);
      const expiresAtStr = await this.secrets
        .get(`mcp/${input.serverName}/expires_at`)
        .catch(() => null);
      return { ok: true, expiresAt: expiresAtStr ?? null };
    } catch (err) {
      return {
        ok: false,
        expiresAt: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  async rename(input) {
    const existing = await this.mcpJsonStore.get(input.newName);
    if (existing) {
      throw new Error(`Server '${input.newName}' already exists`);
    }
    const config = await this.mcpJsonStore.get(input.oldName);
    if (!config) {
      throw new Error(`Server '${input.oldName}' not found`);
    }
    // Migrate secrets before rename so the new name has valid credentials
    const secretKeys = await this.secrets.list(`mcp/${input.oldName}/`);
    for (const key of secretKeys) {
      const value = await this.secrets.get(key);
      if (value) {
        const newKey = key.replace(`mcp/${input.oldName}/`, `mcp/${input.newName}/`);
        await this.secrets.set(newKey, value);
      }
    }
    // Manager rename first — if it fails, secrets are duplicated (harmless) but
    // mcp.json and runtime stay consistent.
    try {
      await this.mcpManager.renameServer(input.oldName, input.newName);
    } catch {
      // Manager may not have this server loaded (e.g. stdio not started).
      // Proceed with persistence — the rename takes effect on next boot.
    }
    // Persist only after manager succeeds (or is inapplicable)
    const newConfig = { ...config, name: input.newName };
    await this.mcpJsonStore.remove(input.oldName);
    await this.mcpJsonStore.upsert(input.newName, newConfig);
    // Clean up old secret keys after successful persistence
    for (const key of secretKeys) {
      await this.secrets.delete(key).catch(() => {});
    }
    return { ok: true };
  }
  async updateToken(input) {
    const config = await this.mcpJsonStore.get(input.serverName);
    if (!config) {
      throw new Error(`Server '${input.serverName}' not found`);
    }
    if (config.auth?.type !== 'bearer') {
      throw new Error(`Server '${input.serverName}' does not use bearer auth`);
    }
    await this.secrets.set(`mcp/${input.serverName}/access_token`, input.token);
    try {
      await this.mcpManager.updateToken(input.serverName, input.token);
    } catch {
      // Token stored; reconnect will use it on next attempt
    }
    return { ok: true };
  }
  async scopeStatus(input) {
    const configs = await this.mcpJsonStore.read();
    const config = configs.find((c) => c.name === input.serverName);
    if (!config?.auth || config.auth.type !== 'oauth2') {
      return {
        outcome: 'inactive',
        declaredScopes: [],
        actualScopes: [],
      };
    }
    const declaredScopes = config.auth.scopes ?? [];
    return {
      outcome: 'unknown',
      declaredScopes,
      actualScopes: [],
    };
  }
  async validateConfig(input) {
    const errors = [];
    if (input.transport === 'stdio') {
      if (!input.command) {
        errors.push({ field: 'command', message: 'Required for stdio transport' });
      }
    } else {
      if (!input.url) {
        errors.push({ field: 'url', message: 'Required for HTTP transports' });
      } else {
        try {
          new URL(input.url);
        } catch {
          errors.push({ field: 'url', message: 'Must be a valid URL' });
        }
      }
    }
    if (input.name) {
      if (input.name.length > 64) {
        errors.push({ field: 'name', message: 'Max 64 characters' });
      }
      const existingConfig = await this.mcpJsonStore.get(input.name);
      if (existingConfig) {
        errors.push({ field: 'name', message: 'Name already taken' });
      }
    }
    return { valid: errors.length === 0, errors };
  }
  async computeAuthStatus(serverName, secrets, config) {
    if (config?.auth?.type !== 'oauth2') return 'none';
    const token = await secrets.get(`mcp/${serverName}/access_token`).catch(() => null);
    if (!token) return 'missing';
    const expiresAtStr = await secrets.get(`mcp/${serverName}/expires_at`).catch(() => null);
    if (expiresAtStr) {
      return Date.now() >= Number(expiresAtStr) ? 'expired' : 'authorized';
    }
    return 'authorized';
  }
  async reconnect(input) {
    const configs = await this.mcpJsonStore.read();
    const existing = configs.find((c) => c.name === input.name);
    if (!existing?.url) {
      return {
        ok: false,
        code: 'discovery_failed',
        detail: `Server '${input.name}' not found or has no URL`,
      };
    }
    const startInput = {
      url: existing.url,
      name: input.name,
    };
    if (input.personalityId !== undefined) startInput.personalityId = input.personalityId;
    return this.start(startInput);
  }
}
