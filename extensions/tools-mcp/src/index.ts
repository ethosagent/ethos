import { homedir } from 'node:os';
import { join } from 'node:path';
import { noopLogger } from '@ethosagent/logger';
import { buildMcpEnv } from '@ethosagent/safety-scanner';
import { FsStorage } from '@ethosagent/storage-fs';
import type { Logger, Storage, Tool, ToolResult } from '@ethosagent/types';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
  transport: 'stdio' | 'sse';
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
}

export interface McpManagerConfig {
  logger?: Logger;
  /** How to handle tool-name collisions across servers. Default: 'warn'. */
  collisionPolicy?: 'warn' | 'error';
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
  private _transport: {
    close?: () => Promise<void> | void;
    _process?: { kill: (sig: string) => void };
  } | null = null;
  private _logger: Logger;

  constructor(config: McpServerConfig, opts?: { logger?: Logger }) {
    this._config = config;
    this._sdk = new Client({ name: 'ethos', version: '1.0.0' }, { capabilities: {} });
    this._logger = opts?.logger ?? noopLogger;
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
    this._startKeepalive();
  }

  private _startKeepalive(): void {
    const seconds = this._config.keepaliveSeconds ?? 30;
    if (seconds <= 0) return;

    this._keepaliveInterval = setInterval(async () => {
      try {
        await Promise.race([
          this._sdk.ping(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('ping timeout')), 5000),
          ),
        ]);
      } catch {
        this._logger.warn(
          `[ethos] MCP server '${this._config.name}' keepalive failed, reconnecting`,
          { component: 'tools-mcp', server: this._config.name },
        );
        this._clearKeepalive();
        this._connected = false;
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

    if (this._config.transport === 'sse') {
      const { url } = this._config;
      if (!url) throw new Error(`MCP server '${this._config.name}': sse transport requires 'url'`);
      // Lazy import to avoid pulling in eventsource when not needed
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
      return new SSEClientTransport(new URL(url), {
        requestInit: this._config.headers ? { headers: this._config.headers } : undefined,
      });
    }

    throw new Error(
      `MCP server '${this._config.name}': unknown transport '${this._config.transport}'`,
    );
  }

  private _scheduleReconnect(attempt: number): void {
    if (this._destroyed || attempt >= 5) return;
    const delay = Math.min(1000 * 2 ** attempt, 30_000);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      // Re-create the SDK client — old one is done
      this._sdk = new Client({ name: 'ethos', version: '1.0.0' }, { capabilities: {} });
      const timeoutMs = this._config.connectTimeoutMs ?? 10_000;
      try {
        await Promise.race([
          this.connect(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('connect timeout')), timeoutMs),
          ),
        ]);
      } catch {
        this._scheduleReconnect(attempt + 1);
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
      inputSchema: t.inputSchema as Record<string, unknown>,
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
      const content = raw.content as Array<{ type: string; text?: string }>;
      const text = content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n');

      if (isError) {
        return { ok: false, error: text || 'Tool returned an error', code: 'execution_failed' };
      }
      return { ok: true, value: text || '(no output)' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (allowRetry && this._isConnectionError(msg)) {
        this._logger.warn(
          `[ethos] MCP server '${this._config.name}' pipe error, retrying once`,
          { component: 'tools-mcp', server: this._config.name, error: msg },
        );
        // Trigger reconnect and wait briefly for it
        if (!this._destroyed) this._scheduleReconnect(0);
        await new Promise((resolve) => setTimeout(resolve, 1500));
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

    // For stdio transports, ensure child process is terminated
    const proc = this._transport?._process;
    if (proc) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Process may already be dead
      }
      // Schedule SIGKILL after grace period in case SIGTERM is ignored
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, 2000);
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
    this._clients = configs.map((c) => new McpClient(c, { logger: this.logger }));
  }

  async connect(): Promise<void> {
    // Collect tools per server for collision detection
    const toolsByServer = new Map<string, McpToolDef[]>();

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
            this._tools.push(adaptMcpTool(t, client.name, client));
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

    // Cross-server tool-name collision detection
    this._detectCollisions(toolsByServer);
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

      const msg =
        `[ethos] Tool name collision: '${toolName}' exposed by servers: ${servers.join(', ')}`;
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
