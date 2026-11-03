---
title: "MCP config: scoping, tool naming, examples and errors"
description: "MCP scoping, tool naming, examples and common errors."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

How MCP servers are scoped and named, with examples and error fixes. Part of the [MCP config reference](../mcp-config.md).

## Personality scoping {#scoping}

Configuring a server in `mcp.json` makes it **available** to Ethos. It does **not** automatically expose the server's tools to any personality. Each personality declares an allowlist in its own `config.yaml`:

```yaml
# ~/.ethos/personalities/engineer/config.yaml
mcp_servers:
  - filesystem
  - github
```

The boot log line `MCP: 0 of N server(s) attached to "<personality>"` means the operator configured N servers globally but the personality has an empty allowlist. Fix at the attachment layer:

```bash
ethos personality mcp engineer --attach filesystem
ethos personality mcp engineer --detach filesystem
ethos personality mcp engineer            # list current attachments
```

The personality registry watches `config.yaml`'s mtime and reloads on the next turn — no daemon restart needed.

See also the [`native-mcp`](https://github.com/ethosagent/ethos/blob/main/skills/framework/native-mcp/SKILL.md) bundled skill for the operator workflow this reference is the schema for.

## Tool naming {#tool-naming}

Every MCP tool is registered under the name `mcp__<name>__<tool>` — double underscore separators, exactly. The format is part of the tool registry's contract; don't transform it elsewhere.

```
mcp__filesystem__read_file
mcp__github__create_issue
mcp__stripe__list_customers
```

`toolset.yaml` does not gate MCP tools. The toolset allowlist applies to built-in tools only. `DefaultToolRegistry.toDefinitions` and `executeParallel` in `packages/core/src/tool-registry.ts` skip it for any `mcp__` name. Listing `mcp__<name>__<tool>` in `toolset.yaml` therefore neither grants nor narrows anything. Two gates decide which MCP tools a personality gets:

1. **Server attachment.** A tool surfaces only if its server is in the personality's `mcp_servers:` list (`passesFilter`, same file).
2. **Per-tool allowlist (optional).** The personality's own `mcp.yaml` (`~/.ethos/personalities/<id>/mcp.yaml`, parsed by `parseMcpYaml` in `extensions/personalities/src/index.ts`) can narrow an attached server to named tools, or switch it off:

```yaml
servers:
  linear:
    tools:
      - list_issues
      - get_issue
  slack:
    enabled: false
```

A server with no entry in `mcp.yaml` exposes every tool it lists. Pinned by `packages/core/src/__tests__/tool-registry-mcp-filter.test.ts`.

The agent loop emits the same prefixed name in `tool_start` / `tool_end` events. Channel adapters and the web UI display them verbatim.

## OSV vulnerability scan (not implemented) {#osv}

**Limitation: no scan runs.** `ethos mcp add` does not query osv.dev, and nothing refuses a server over a known advisory. The helper exists, `checkOsvVulnerabilities` in [`osv-check.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-mcp/src/osv-check.ts), but no command or boot path calls it. `ethos mcp add` has no `--force` flag. Check a community server's package for advisories yourself before you add it.

## Examples {#examples}

### Filesystem (stdio, no credentials) {#example-filesystem}

```json
{
  "name": "filesystem",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/work"]
}
```

### GitHub (stdio, token via passthrough) {#example-github}

```json
{
  "name": "github",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "mcpEnvPassthrough": ["GITHUB_PERSONAL_ACCESS_TOKEN"]
}
```

The operator must export `GITHUB_PERSONAL_ACCESS_TOKEN` in their shell. The token bypasses the credential-pattern strip because it's explicitly listed.

### Stripe (HTTP, bearer via secret resolver) {#example-stripe}

```json
{
  "name": "stripe",
  "transport": "streamable-http",
  "url": "https://mcp.stripe.com",
  "headers": {
    "Authorization": "Bearer ${secrets:stripe/api_key}"
  },
  "keepaliveSeconds": 60,
  "connectTimeoutMs": 15000
}
```

Stored once with `ethos secrets set stripe/api_key sk_live_…`. The header value is the literal string `${secrets:stripe/api_key}` in `mcp.json`.

### Linear (HTTP, OAuth 2.1) {#example-linear}

```json
{
  "name": "linear",
  "transport": "streamable-http",
  "url": "https://mcp.linear.app",
  "auth": {
    "type": "oauth2",
    "authorization_endpoint": "https://linear.app/oauth/authorize",
    "token_endpoint": "https://api.linear.app/oauth/token",
    "client_id": "<app-client-id>",
    "scopes": ["read", "write"]
  }
}
```

First connect opens a browser for the PKCE flow. Tokens land at `~/.ethos/personalities/<id>/mcp/linear/{access_token,refresh_token,expires_at}` (where `<id>` is the personality that ran `ethos mcp login`) and refresh silently thereafter.

### Lookout (HTTP, bearer token) {#example-bearer}

```json
{
  "name": "lookout",
  "transport": "streamable-http",
  "url": "https://lookout.example.com/mcp",
  "auth": { "type": "bearer" }
}
```

After registering the server, set the per-personality token from the personality detail page (**Set token**), or write the file directly:

```bash
mkdir -p ~/.ethos/secrets/personalities/<id>/mcp/lookout
printf '%s' 'tok_…' > ~/.ethos/secrets/personalities/<id>/mcp/lookout/access_token
chmod 0600 ~/.ethos/secrets/personalities/<id>/mcp/lookout/access_token
```

Click **Test connection** on the server row to verify tools surface correctly.

## Common errors {#errors}

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find package '@modelcontextprotocol/sdk'` | Workspace dep missing | `pnpm install` from repo root |
| Server listed but tools missing | Server failed to start | Read the connection error in the output of the process running the agent. Ethos writes no per-server MCP log file |
| `0 of N server(s) attached to "<personality>"` | Personality has no `mcp_servers` allowlist | `ethos personality mcp <id> --attach <name>` |
| HTTP server returns 401 on every call | Token expired or wrong | Re-issue and update the secret with `ethos secrets set`; for OAuth, run `ethos mcp logout <name> --personality <id>` and reconnect |
| Server can't read `~/.ssh` or `~/.aws` | Sandboxed env strips the operator's `HOME` | This is intentional. If the server legitimately needs a file, copy it into `~/.ethos/mcp-runtime/<name>/` or pass the path via an env var listed in `mcpEnvPassthrough` |
| Credential env var "missing" inside the server | Credential-pattern strip removed it | Add the var name to `mcpEnvPassthrough` |
| Bearer server shows `missing` status in web UI | Token file not found for this personality | Open the personality detail page and click **Set token**, or write `~/.ethos/secrets/personalities/<id>/mcp/<name>/access_token` directly (mode 0600) |
| Tool name `mcp__<a>__<tool>` resolves but personality can't call it | Server `<a>` is not in `mcp_servers:`, or the personality's `mcp.yaml` narrows `<a>` to a `tools:` list without this tool (or sets `enabled: false`) | Attach the server, or add the bare tool name to `servers.<a>.tools` in `~/.ethos/personalities/<id>/mcp.yaml`. `toolset.yaml` plays no part |

## See also {#see-also}

- [MCP config reference](../mcp-config.md): the index of every section and its page.
