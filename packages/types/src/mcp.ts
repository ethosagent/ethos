// @ethosagent/types — MCP wire-contract types
//
// `McpServerInfo` is the read-only snapshot returned by `McpManager.listServers()`
// and surfaced to consumers (CLI, web-api) that render MCP server tables. The
// shape is lifted here so the SDK install flow can return it from
// `listServers()` without depending on `@ethosagent/web-contracts`.
//
// `auth_status` is computed lazily by the surface that has token visibility
// — the manager itself does not fill it in.

export type McpTransport = 'stdio' | 'streamable-http' | 'sse';
export type McpAuthStatus = 'authorized' | 'expired' | 'missing' | 'unknown';
export type McpCreatedVia = 'cli' | 'ui';

export interface McpServerInfo {
  name: string;
  transport: McpTransport;
  command?: string;
  url?: string;
  auth_status?: McpAuthStatus;
  created_via?: McpCreatedVia;
}

// ---------------------------------------------------------------------------
// Per-personality MCP policy — loaded from mcp.yaml alongside config.yaml.
// NOT part of the frozen PersonalityConfig schema; carried as a sibling
// artifact on the personality registry's internal representation.
// ---------------------------------------------------------------------------

export interface McpServerPolicy {
  tools?: string[];
  reject_args?: Record<string, Record<string, string[]>>;
}

export interface McpPolicy {
  servers?: Record<string, McpServerPolicy>;
}
