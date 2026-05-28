// @ethosagent/types — MCP wire-contract types
//
// `McpServerInfo` is the read-only snapshot returned by `McpManager.listServers()`
// and surfaced to consumers (CLI, web-api) that render MCP server tables. The
// shape is lifted here so the SDK install flow can return it from
// `listServers()` without depending on `@ethosagent/web-contracts`.
//
// `auth_status` is computed lazily by the surface that has token visibility
// — the manager itself does not fill it in.
export {};
