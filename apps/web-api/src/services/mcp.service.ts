import { SsrfError, validateUrl } from '@ethosagent/core';
import {
  ConfidentialClientUnsupported,
  DcrUnsupported,
  deleteTokens,
  McpInstallFlow,
  type McpJsonStore,
  type McpManager,
  type OAuthConfig,
  OAuthDiscoveryError,
  type PersonalityUpdater,
  revokeToken,
} from '@ethosagent/tools-mcp';
import type { SecretsResolver } from '@ethosagent/types';

export interface McpServiceOptions {
  mcpManager: McpManager;
  personalityUpdater: PersonalityUpdater;
  secrets: SecretsResolver;
  mcpJsonStore: McpJsonStore;
  redirectUri: string;
}

export class McpService {
  private readonly flow: McpInstallFlow;
  private readonly mcpJsonStore: McpJsonStore;
  private readonly mcpManager: McpManager;
  private readonly secrets: SecretsResolver;

  constructor(opts: McpServiceOptions) {
    this.mcpJsonStore = opts.mcpJsonStore;
    this.mcpManager = opts.mcpManager;
    this.secrets = opts.secrets;
    this.flow = new McpInstallFlow({
      mcpManager: opts.mcpManager,
      personalityUpdater: opts.personalityUpdater,
      secrets: opts.secrets,
      mcpJsonStore: opts.mcpJsonStore,
      redirectUri: opts.redirectUri,
    });
  }

  async start(input: { url: string; name?: string }, redirectUri?: string) {
    try {
      validateUrl(input.url, { allowLocalhost: true });
    } catch (err) {
      const detail =
        err instanceof SsrfError ? err.message : 'URL points to a private or reserved IP range';
      return { ok: false as const, code: 'ssrf_blocked' as const, detail };
    }

    try {
      // Prefer the per-flow `redirectUri` (derived from the web request's
      // Origin in routes/rpc.ts). When the caller doesn't supply one (e.g.
      // tests, server-to-server, or a request with no Origin and a
      // non-allowlisted host), `flow.start` falls back to the
      // constructor-level default.
      const startOpts: {
        mcpUrl: string;
        name?: string;
        redirectUri?: string;
      } = { mcpUrl: input.url };
      if (input.name !== undefined) startOpts.name = input.name;
      if (redirectUri !== undefined) startOpts.redirectUri = redirectUri;
      const result = await this.flow.start(startOpts);
      return {
        ok: true as const,
        state: result.state,
        authorizeUrl: result.authorizeUrl,
        serverName: result.serverName,
      };
    } catch (err) {
      if (err instanceof OAuthDiscoveryError) {
        return { ok: false as const, code: 'discovery_failed' as const, detail: err.message };
      }
      if (err instanceof DcrUnsupported) {
        return { ok: false as const, code: 'dcr_unsupported' as const, detail: err.message };
      }
      if (err instanceof ConfidentialClientUnsupported) {
        return { ok: false as const, code: 'dcr_failed' as const, detail: err.message };
      }
      // McpInstallFlow uses EthosError with a stable `kind` discriminator in
      // `details` to indicate which UI error code to surface. Keep this in
      // sync with the discriminators set by install-flow.ts.
      const coded = err as Error & { code?: string; details?: { kind?: string } };
      const kind = coded.details?.kind;
      if (kind === 'name_taken' || coded.code === 'name_taken') {
        return { ok: false as const, code: 'name_taken' as const, detail: coded.message };
      }
      return {
        ok: false as const,
        code: 'discovery_failed' as const,
        detail: coded.message ?? 'Unknown error',
      };
    }
  }

  async complete(input: { code?: string; state: string; error?: string }, cookieState?: string) {
    // CSRF check: the pending cookie must match the state from the input.
    if (!cookieState) {
      return {
        ok: false as const,
        code: 'missing_pending_cookie' as const,
        detail: 'OAuth session expired — please retry from the UI.',
      };
    }
    if (cookieState !== input.state) {
      return {
        ok: false as const,
        code: 'state_mismatch' as const,
        detail: 'OAuth state mismatch — possible CSRF.',
      };
    }

    if (input.error) {
      return { ok: false as const, code: 'upstream_error' as const, detail: input.error };
    }
    if (!input.code) {
      return {
        ok: false as const,
        code: 'code_exchange_failed' as const,
        detail: 'Missing authorization code',
      };
    }
    try {
      const result = await this.flow.complete({ code: input.code, state: input.state });
      return { ok: true as const, serverName: result.serverName };
    } catch (err) {
      const coded = err as Error & { code?: string; details?: { kind?: string } };
      const kind = coded.details?.kind ?? coded.code;
      const code =
        kind === 'expired_state' || kind === 'already_completed'
          ? ('expired_state' as const)
          : ('code_exchange_failed' as const);
      return { ok: false as const, code, detail: coded.message };
    }
  }

  status(cookieState?: string) {
    if (!cookieState) return { status: 'expired' as const };
    return this.getStatus(cookieState);
  }

  getStatus(state: string) {
    return { status: this.flow.getStatus(state) };
  }

  async cancel(state: string) {
    await this.flow.cancel(state);
    return { ok: true as const };
  }

  async attachPersonalities(input: { serverName: string; personalityIds: string[] }) {
    return this.flow.attachToPersonalities(input);
  }

  async list() {
    const configs = await this.mcpJsonStore.read();
    const servers = await Promise.all(
      configs.map(async (c) => {
        let authStatus: 'none' | 'authorized' | 'expired' | 'missing' | 'pending' | null = null;
        if (c.auth?.type === 'oauth2') {
          const token = await this.secrets.get(`mcp/${c.name}/access_token`).catch(() => null);
          if (!token) {
            authStatus = 'missing';
          } else {
            const expiresAtStr = await this.secrets
              .get(`mcp/${c.name}/expires_at`)
              .catch(() => null);
            if (expiresAtStr) {
              const expiresAt = Number(expiresAtStr);
              authStatus = Date.now() >= expiresAt ? 'expired' : 'authorized';
            } else {
              authStatus = 'authorized';
            }
          }
        } else {
          authStatus = 'none';
        }
        return {
          name: c.name,
          transport: c.transport as 'stdio' | 'sse' | 'streamable-http',
          command: typeof c.command === 'string' ? c.command : null,
          url: typeof c.url === 'string' ? c.url : null,
          auth_status: authStatus,
          created_via: c.created_via ?? null,
        };
      }),
    );
    return { servers };
  }

  async delete(input: { name: string }) {
    // Read config before removing so we can revoke tokens
    const configs = await this.mcpJsonStore.read();
    const config = configs.find((c) => c.name === input.name);

    // Revoke + delete tokens if the server had OAuth auth
    if (config?.auth?.type === 'oauth2') {
      const oauthConfig: OAuthConfig = {
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
    return { ok: true as const };
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
  async serverTools(input: { personalityId: string; serverName: string }) {
    const prefix = `mcp__${input.serverName}__`;
    let all: Awaited<ReturnType<McpManager['getToolsForPersonality']>>;
    try {
      all = await this.mcpManager.getToolsForPersonality(input.personalityId);
    } catch {
      return { available: false as const, tools: [] };
    }
    const tools = all
      .filter((t) => t.name.startsWith(prefix))
      .map((t) => {
        const bare = t.name.slice(prefix.length);
        return t.description && t.description !== bare
          ? { name: bare, description: t.description }
          : { name: bare };
      });
    return { available: tools.length > 0, tools };
  }

  async reconnect(input: { name: string }) {
    const configs = await this.mcpJsonStore.read();
    const existing = configs.find((c) => c.name === input.name);
    if (!existing?.url) {
      return {
        ok: false as const,
        code: 'discovery_failed' as const,
        detail: `Server '${input.name}' not found or has no URL`,
      };
    }
    return this.start({ url: existing.url, name: input.name });
  }
}
