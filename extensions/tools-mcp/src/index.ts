import { homedir } from 'node:os';
import { join } from 'node:path';
import { noopLogger } from '@ethosagent/logger';
import { buildMcpEnv } from '@ethosagent/safety-scanner';
import { FsStorage } from '@ethosagent/storage-fs';
import type { Logger, SecretsResolver, Storage, Tool, ToolResult } from '@ethosagent/types';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { ensureValidToken, refreshToken } from './oauth';
import { rewriteDefinitionsToRefs } from './schema-rewrite';

export type { CallbackResult, OAuthConfig, TokenSet } from './oauth';
export {
  buildAuthorizationUrl,
  deleteTokens,
  ensureValidToken,
  exchangeCode,
  generateCodeChallenge,
  generateCodeVerifier,
  isTokenExpired,
  loadAccessToken,
  refreshToken,
  revokeToken,
  runPkceLogin,
  startCallbackServer,
  storeTokens,
} from './oauth';
export type { OsvAdvisory, OsvResult } from './osv-check';
export { checkOsvVulnerabilities, clearOsvCache } from './osv-check';
export type { McpPreset } from './presets';
export { getPreset, MCP_PRESETS } from './presets';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Keys that buildMcpEnv intentionally pins to the sandbox — config.env cannot override them.
const PINNED_MCP_KEYS = new Set([
  'HOME',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
]);
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  name: string;
  transport:
    | 'stdio'
    | 'streamable-http'
    | /** @deprecated Use 'streamable-http' for HTTP-based MCP servers. Legacy SSE kept for one release. */ 'sse';
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Env vars to pass through to the subprocess beyond the safe defaults. Credential-pattern vars are still stripped unless explicitly listed here. */
  mcpEnvPassthrough?: string[];
  // sse
  url?: string;
  headers?: Record<string, string>;
  /** Seconds between keepalive pings. Default 30, 0 to disable. */
  keepaliveSeconds?: number;
  /** Timeout in ms for reconnect attempts. Default 10_000. */
  connectTimeoutMs?: number;
  /** OAuth 2.1 configuration for servers that require authorization. */
  auth?: {
    type: 'oauth2';
    authorization_endpoint: string;
    token_endpoint: string;
    client_id: string;
    scopes?: string[];
    revocation_endpoint?: string;
  };
}

export interface McpManagerConfig {
  logger?: Logger;
  /** How to handle tool-name collisions across servers. Default: 'warn'. */
  collisionPolicy?: 'warn' | 'error';
  /** Secrets resolver for OAuth token storage. Required for servers with auth config. */
  secrets?: SecretsResolver;
}

// ---------------------------------------------------------------------------
// McpClient — wraps one MCP server connection
// ---------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export class McpClient {
  private _sdk: Client;
  private _config: McpServerConfig;
  private _connected = false;
  private _pending = new Map<symbol, (err: Error) => void>();
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _keepaliveInterval: ReturnType<typeof setInterval> | null = null;
  private _destroyed = false;
  private _transport: { close?: () => Promise<void> | void } | null = null;
  private _generation = 0;
  private _reconnectResolve: (() => void) | null = null;
  private _reconnectPromise: Promise<void> | null = null;
  private _logger: Logger;
  private _secrets?: SecretsResolver;

  /** Callback invoked when the server sends `notifications/tools/list_changed`. */
  onToolsChanged?: (tools: McpToolDef[]) => void;

  constructor(config: McpServerConfig, opts?: { logger?: Logger; secrets?: SecretsResolver }) {
    this._config = config;
    this._sdk = new Client({ name: 'ethos', version: '1.0.0' }, { capabilities: {} });
    this._logger = opts?.logger ?? noopLogger;
    this._secrets = opts?.secrets;
  }

  get name(): string {
    return this._config.name;
  }

  async connect(): Promise<void> {
    const transport = await this._createTransport();
    this._transport = transport as typeof this._transport;

    this._sdk.onclose = () => {
      this._connected = false;
      this._clearKeepalive();
      const err = new Error(`MCP server '${this._config.name}' disconnected`);
      for (const reject of this._pending.values()) reject(err);
      this._pending.clear();
      if (!this._destroyed) this._scheduleReconnect(0);
    };

    await this._sdk.connect(transport);
    this._connected = true;

    // Phase 2.3 — dynamic tool discovery via notifications/tools/list_changed
    this._sdk.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        const tools = await this.listTools();
        this.onToolsChanged?.(tools);
      } catch (err) {
        this._logger.warn(
          `[ethos] MCP server '${this._config.name}' tools/list_changed re-fetch failed`,
          {
            component: 'tools-mcp',
            server: this._config.name,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    });

    this._startKeepalive();
  }

  private _startKeepalive(): void {
    const seconds = this._config.keepaliveSeconds ?? 30;
    if (seconds <= 0) return;

    this._keepaliveInterval = setInterval(async () => {
      try {
        await Promise.race([
          this._sdk.ping(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 5000)),
        ]);
      } catch {
        this._logger.warn(
          `[ethos] MCP server '${this._config.name}' keepalive failed, reconnecting`,
          { component: 'tools-mcp', server: this._config.name },
        );
        this._clearKeepalive();
        this._connected = false;
        try {
          await this._transport?.close?.();
        } catch {
          /* ignore */
        }
        try {
          await this._sdk.close();
        } catch {
          /* ignore */
        }
        this._transport = null;
        if (!this._destroyed) this._scheduleReconnect(0);
      }
    }, seconds * 1000);
  }

  private _clearKeepalive(): void {
    if (this._keepaliveInterval) {
      clearInterval(this._keepaliveInterval);
      this._keepaliveInterval = null;
    }
  }

  protected async _createTransport() {
    if (this._config.transport === 'stdio') {
      const { command } = this._config;
      if (!command)
        throw new Error(`MCP server '${this._config.name}': stdio transport requires 'command'`);
      const safeEnv = buildMcpEnv(this._config.name, this._config.mcpEnvPassthrough);
      // Merge config.env overrides under two constraints:
      //  1. Pinned sandbox dirs (HOME, XDG_*, TMPDIR) can never be overridden.
      //  2. A key must already be present in safeEnv (baseline) OR be explicitly
      //     listed in mcpEnvPassthrough — config.env cannot inject new arbitrary vars.
      const mergedEnv = { ...safeEnv };
      if (this._config.env) {
        const declared = new Set(this._config.mcpEnvPassthrough ?? []);
        for (const [key, value] of Object.entries(this._config.env)) {
          if (PINNED_MCP_KEYS.has(key)) continue;
          if (!(key in safeEnv) && !declared.has(key)) continue;
          mergedEnv[key] = value;
        }
      }
      return new StdioClientTransport({
        command,
        args: this._config.args,
        env: mergedEnv,
        stderr: 'pipe',
      });
    }

    if (this._config.transport === 'streamable-http') {
      const { url } = this._config;
      if (!url)
        throw new Error(
          `MCP server '${this._config.name}': streamable-http transport requires 'url'`,
        );
      const headers = { ...this._config.headers };
      if (this._config.auth?.type === 'oauth2' && this._secrets) {
        const token = await ensureValidToken(this._config.name, this._config.auth, this._secrets);
        headers.Authorization = `Bearer ${token}`;
      }
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      );
      return new StreamableHTTPClientTransport(new URL(url), {
        requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
      });
    }

    if (this._config.transport === 'sse') {
      const { url } = this._config;
      if (!url) throw new Error(`MCP server '${this._config.name}': sse transport requires 'url'`);
      this._logger.warn(
        `[ethos] MCP '${this._config.name}': SSE transport is deprecated, use 'streamable-http'`,
        { component: 'tools-mcp', server: this._config.name },
      );
      const headers = { ...this._config.headers };
      if (this._config.auth?.type === 'oauth2' && this._secrets) {
        const token = await ensureValidToken(this._config.name, this._config.auth, this._secrets);
        headers.Authorization = `Bearer ${token}`;
      }
      // Lazy import to avoid pulling in eventsource when not needed
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
      return new SSEClientTransport(new URL(url), {
        requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
      });
    }

    throw new Error(
      `MCP server '${this._config.name}': unknown transport '${this._config.transport}'`,
    );
  }

  private _scheduleReconnect(attempt: number): void {
    if (this._destroyed || attempt >= 5) return;
    if (!this._reconnectPromise) {
      this._reconnectPromise = new Promise((resolve) => {
        this._reconnectResolve = resolve;
      });
    }
    const delay = Math.min(1000 * 2 ** attempt, 30_000);
    const gen = ++this._generation;
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._destroyed || gen !== this._generation) return;
      this._sdk = new Client({ name: 'ethos', version: '1.0.0' }, { capabilities: {} });
      const timeoutMs = this._config.connectTimeoutMs ?? 10_000;
      try {
        await Promise.race([
          this.connect(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('connect timeout')), timeoutMs),
          ),
        ]);
        if (gen !== this._generation) {
          try {
            await this._sdk.close();
          } catch {
            /* stale */
          }
          return;
        }
        this._reconnectResolve?.();
        this._reconnectPromise = null;
        this._reconnectResolve = null;
      } catch {
        if (gen === this._generation) this._scheduleReconnect(attempt + 1);
      }
    }, delay);
  }

  isConnected(): boolean {
    return this._connected;
  }

  async listTools(): Promise<McpToolDef[]> {
    const result = await this._sdk.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: rewriteDefinitionsToRefs(t.inputSchema as Record<string, unknown>),
    }));
  }

  async callTool(name: string, args: unknown): Promise<ToolResult> {
    return this._callToolInner(name, args, true);
  }

  private async _callToolInner(
    name: string,
    args: unknown,
    allowRetry: boolean,
  ): Promise<ToolResult> {
    if (!this._connected) {
      return {
        ok: false,
        error: `MCP server '${this._config.name}' is not connected`,
        code: 'not_available',
      };
    }

    const key = Symbol();
    const guard = new Promise<never>((_, reject) => {
      this._pending.set(key, reject);
    });

    try {
      const raw = await Promise.race([
        this._sdk.callTool({ name, arguments: args as Record<string, unknown> }),
        guard,
      ]);

      const isError = raw.isError === true;

      // Phase 2.4/2.5 — structuredContent handling (newer MCP spec)
      const structured = (raw as Record<string, unknown>).structuredContent as unknown;
      const content = raw.content as
        | Array<{ type: string; text?: string; data?: string; mimeType?: string }>
        | undefined;

      // Phase 2.5 — merge both when structuredContent (non-sentinel) and content co-exist
      if (structured && structured !== 'no_mcp' && content?.length) {
        const textPart = content
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('\n');
        const json = JSON.stringify(structured, null, 2);
        const merged = textPart ? `${textPart}\n\n--- Structured Data ---\n${json}` : json;
        if (isError) {
          return { ok: false, error: merged || 'Tool returned an error', code: 'execution_failed' };
        }
        return { ok: true, value: merged };
      }

      // Phase 2.4 — structuredContent only (no content or empty content)
      if (structured && structured !== 'no_mcp') {
        const text = JSON.stringify(structured, null, 2);
        if (isError) {
          return { ok: false, error: text || 'Tool returned an error', code: 'execution_failed' };
        }
        return { ok: true, value: text };
      }

      // Phase 2.6 — fall back to content blocks, handling image blocks
      const parts: string[] = [];
      for (const block of content ?? []) {
        if (block.type === 'text') {
          parts.push(block.text ?? '');
        } else if (block.type === 'image') {
          parts.push(
            `[Image: ${block.mimeType ?? 'image/unknown'}, ${block.data?.length ?? 0} bytes base64]`,
          );
        }
      }
      const text = parts.join('\n');

      if (isError) {
        return { ok: false, error: text || 'Tool returned an error', code: 'execution_failed' };
      }
      return { ok: true, value: text || '(no output)' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // OAuth 401 retry — refresh token and reconnect once
      if (
        allowRetry &&
        this._is401Error(msg) &&
        this._config.auth?.type === 'oauth2' &&
        this._secrets
      ) {
        this._logger.warn(
          `[ethos] MCP server '${this._config.name}' returned 401, attempting token refresh`,
          { component: 'tools-mcp', server: this._config.name },
        );
        try {
          await refreshToken(this._config.name, this._config.auth, this._secrets);
          // Reconnect with fresh token
          this._connected = false;
          try {
            await this._transport?.close?.();
          } catch {
            /* ignore */
          }
          this._sdk = new Client({ name: 'ethos', version: '1.0.0' }, { capabilities: {} });
          await this.connect();
          return this._callToolInner(name, args, false);
        } catch {
          // Refresh failed — fall through to error
        }
      }

      if (allowRetry && this._isConnectionError(msg)) {
        this._logger.warn(`[ethos] MCP server '${this._config.name}' pipe error, retrying once`, {
          component: 'tools-mcp',
          server: this._config.name,
          error: msg,
        });
        this._connected = false;
        if (!this._destroyed) this._scheduleReconnect(0);
        if (this._reconnectPromise) {
          const deadline = this._config.connectTimeoutMs ?? 10_000;
          await Promise.race([this._reconnectPromise, new Promise((r) => setTimeout(r, deadline))]);
        }
        return this._callToolInner(name, args, false);
      }
      return {
        ok: false,
        error: msg,
        code: 'execution_failed',
      };
    } finally {
      this._pending.delete(key);
    }
  }

  private _is401Error(msg: string): boolean {
    return msg.includes('401') || msg.toLowerCase().includes('unauthorized');
  }

  private _isConnectionError(msg: string): boolean {
    const patterns = [
      'EPIPE',
      'ECONNRESET',
      'ECONNREFUSED',
      'connection closed',
      'write after end',
      'socket hang up',
    ];
    const lower = msg.toLowerCase();
    return patterns.some((p) => lower.includes(p.toLowerCase()));
  }

  async disconnect(): Promise<void> {
    this._destroyed = true;
    this._clearKeepalive();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._connected = false;

    // Close the transport
    if (this._transport?.close) {
      try {
        await this._transport.close();
      } catch {
        // Ignore transport close errors
      }
    }

    this._transport = null;

    try {
      await this._sdk.close();
    } catch {
      // Ignore errors on close
    }
  }
}

// ---------------------------------------------------------------------------
// Tool adapter
// ---------------------------------------------------------------------------

function adaptMcpTool(mcpTool: McpToolDef, serverName: string, client: McpClient): Tool {
  return {
    name: `mcp__${serverName}__${mcpTool.name}`,
    description: mcpTool.description ?? mcpTool.name,
    schema: mcpTool.inputSchema,
    toolset: 'mcp',
    maxResultChars: 50_000,
    capabilities: {
      network: { allowedHosts: ['*'] }, // MCP server may access arbitrary hosts
      process: { allowedBinaries: ['*'] },
    },
    isAvailable: () => client.isConnected(),
    execute(args) {
      return client.callTool(mcpTool.name, args);
    },
  };
}

// ---------------------------------------------------------------------------
// McpManager — manages multiple clients
// ---------------------------------------------------------------------------

export class McpManager {
  private _clients: McpClient[];
  private _tools: Tool[] = [];
  private readonly logger: Logger;
  private readonly _collisionPolicy: 'warn' | 'error';

  constructor(configs: McpServerConfig[], opts: McpManagerConfig = {}) {
    this.logger = opts.logger ?? noopLogger;
    this._collisionPolicy = opts.collisionPolicy ?? 'warn';
    this._clients = configs.map((c) => {
      const client = new McpClient(c, { logger: this.logger, secrets: opts.secrets });
      // Phase 2.3 — wire dynamic tool discovery callback
      client.onToolsChanged = (newTools) => {
        const prefix = `mcp__${client.name}__`;
        this._tools = this._tools.filter((t) => !t.name.startsWith(prefix));
        for (const t of newTools) {
          this._tools.push(adaptMcpTool(t, client.name, client));
        }
      };
      return client;
    });
  }

  async connect(): Promise<void> {
    const toolsByServer = new Map<string, McpToolDef[]>();
    const pendingTools: Tool[] = [];

    await Promise.allSettled(
      this._clients.map(async (client) => {
        try {
          await client.connect();
        } catch (err) {
          this.logger.warn(`[ethos] MCP server '${client.name}' failed to connect`, {
            component: 'tools-mcp',
            server: client.name,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }

        try {
          const mcpTools = await client.listTools();
          toolsByServer.set(client.name, mcpTools);
          for (const t of mcpTools) {
            pendingTools.push(adaptMcpTool(t, client.name, client));
          }
        } catch (err) {
          this.logger.warn(`[ethos] MCP server '${client.name}' listTools failed`, {
            component: 'tools-mcp',
            server: client.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    try {
      this._detectCollisions(toolsByServer);
    } catch (err) {
      await this.disconnect();
      throw err;
    }
    this._tools = pendingTools;
  }

  private _detectCollisions(toolsByServer: Map<string, McpToolDef[]>): void {
    const nameToServers = new Map<string, string[]>();
    for (const [serverName, tools] of toolsByServer) {
      for (const tool of tools) {
        const existing = nameToServers.get(tool.name);
        if (existing) {
          existing.push(serverName);
        } else {
          nameToServers.set(tool.name, [serverName]);
        }
      }
    }

    for (const [toolName, servers] of nameToServers) {
      if (servers.length < 2) continue;

      const msg = `[ethos] Tool name collision: '${toolName}' exposed by servers: ${servers.join(', ')}`;
      if (this._collisionPolicy === 'error') {
        throw new Error(msg);
      }
      this.logger.warn(msg, {
        component: 'tools-mcp',
        toolName,
        servers,
      });
    }
  }

  getTools(): Tool[] {
    return this._tools;
  }

  async disconnect(): Promise<void> {
    await Promise.allSettled(this._clients.map((c) => c.disconnect()));
  }

  /** Alias for disconnect — intention-revealing name for lifecycle management. */
  async shutdown(): Promise<void> {
    return this.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Glob matching — simple patterns for personality MCP allowlists
// ---------------------------------------------------------------------------

export function matchesGlob(name: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    return name.startsWith(pattern.slice(0, -1));
  }
  return name === pattern;
}

export function isServerAllowed(serverName: string, allowlist: string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return true; // open mode
  return allowlist.some((pattern) => matchesGlob(serverName, pattern));
}

// ---------------------------------------------------------------------------
// McpSessionView — per-session MCP merging layer (Phase 5)
// ---------------------------------------------------------------------------

export class McpSessionView {
  private readonly _global: McpManager;
  private readonly _sessionClients: McpClient[] = [];
  private readonly _sessionTools: Tool[] = [];

  constructor(globalManager: McpManager) {
    this._global = globalManager;
  }

  /**
   * Connect session-scoped MCP servers, filtering against the personality allowlist.
   * Allowed servers are connected and their tools registered; disallowed ones are rejected.
   */
  async registerSessionServers(
    configs: McpServerConfig[],
    allowlist: string[] | undefined,
    logger?: Logger,
  ): Promise<{ registered: string[]; rejected: { name: string; reason: string }[] }> {
    const registered: string[] = [];
    const rejected: { name: string; reason: string }[] = [];

    for (const config of configs) {
      if (!isServerAllowed(config.name, allowlist)) {
        rejected.push({
          name: config.name,
          reason: `Server '${config.name}' not in personality MCP allowlist`,
        });
        continue;
      }

      const client = new McpClient(config, { logger });
      try {
        await client.connect();
        const mcpTools = await client.listTools();
        for (const t of mcpTools) {
          const tool = adaptMcpTool(t, config.name, client);
          this._sessionTools.push({ ...tool, mcpSource: 'client' } as Tool);
        }
        this._sessionClients.push(client);
        registered.push(config.name);
      } catch (err) {
        rejected.push({
          name: config.name,
          reason: err instanceof Error ? err.message : String(err),
        });
        // Ensure cleanup on failed connect
        try {
          await client.disconnect();
        } catch {
          /* ignore */
        }
      }
    }

    return { registered, rejected };
  }

  getTools(): Tool[] {
    return [...this._global.getTools(), ...this._sessionTools];
  }

  getSessionTools(): Tool[] {
    return this._sessionTools;
  }

  isSessionTool(toolName: string): boolean {
    return this._sessionTools.some((t) => t.name === toolName);
  }

  async teardown(): Promise<void> {
    await Promise.allSettled(this._sessionClients.map((c) => c.disconnect()));
    this._sessionClients.length = 0;
    this._sessionTools.length = 0;
  }
}
// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

export async function loadMcpConfig(
  storage: Storage = new FsStorage(),
): Promise<McpServerConfig[]> {
  const path = join(homedir(), '.ethos', 'mcp.json');
  const raw = await storage.read(path);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as McpServerConfig[];
  } catch {
    return [];
  }
}

// Re-export schema rewrite helper for external use / testing
export { rewriteDefinitionsToRefs } from './schema-rewrite';
