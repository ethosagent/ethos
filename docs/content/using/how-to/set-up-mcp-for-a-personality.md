---
title: "Set up MCP for a personality"
description: "Register an MCP server, acquire a per-personality token via CLI or web OAuth, and verify the tools surface in chat."
kind: how-to
audience: user
slug: set-up-mcp-for-a-personality
time: "10 min"
updated: 2026-05-22
---

## Task

Attach an MCP server to a specific [personality](../../getting-started/glossary.md#personality) so its tools are available in chat.

## Result

The personality can call the server's tools. Tokens are stored per-personality at `~/.ethos/personalities/<id>/mcp/<name>/` — no other personality inherits the credential.

## Prereqs

- `ethos` installed and a provider configured ([Configure an LLM provider](configure-providers.md)).
- At least one personality created (`ethos personality list` shows it).
- For OAuth-protected servers: a browser reachable from the machine running `ethos` (the PKCE flow opens a tab).
- For the web path: `ethos serve --web` running.

## Steps — CLI path

### 1. Register the server

```bash
ethos mcp add --url https://mcp.linear.app
```

This writes an entry to `~/.ethos/mcp.json`. The [OSV vulnerability scan](../reference/mcp-config.md#osv) runs automatically for npm-backed servers. No token is stored at this step — the server is defined but unauthenticated.

For stdio servers that don't use OAuth:

```bash
ethos mcp add --name filesystem --transport stdio \
  --command npx --args '-y @modelcontextprotocol/server-filesystem /Users/me/work'
```

Stdio servers with no `auth` block don't need a `login` step — skip to step 3.

### 2. Acquire a per-personality token

```bash
ethos mcp login linear --personality engineer
```

A browser opens for the PKCE flow. After you authorise, the token lands at:

```text
~/.ethos/personalities/engineer/mcp/linear/access_token
~/.ethos/personalities/engineer/mcp/linear/refresh_token
~/.ethos/personalities/engineer/mcp/linear/expires_at
```

Each personality that needs access must run `login` separately. Tokens are never shared across personalities.

To authenticate a second personality against the same server:

```bash
ethos mcp login linear --personality researcher
```

### 3. Attach the server to the personality

Edit `~/.ethos/personalities/engineer/config.yaml` to list the server:

```yaml
# ~/.ethos/personalities/engineer/config.yaml
mcp_servers:
  - linear
```

Or use the CLI shorthand:

```bash
ethos personality mcp engineer --attach linear
```

### 4. Verify the attachment

```bash
ethos personality show engineer
```

The character sheet lists the MCP servers under the "MCP servers" heading. The server name appears with its transport type and connection status.

### 5. Test in chat

```bash
ethos chat
```

```text
/personality engineer
What MCP tools do you have?
```

The agent responds with the tool list from the server (e.g. `mcp__linear__create_issue`, `mcp__linear__list_issues`). If the server requires a token and step 2 was skipped, the agent reports an authentication error.

## Steps — Web path

### 1. Open the web dashboard

```bash
ethos serve --web
```

Navigate to `http://localhost:3000` (or the configured port).

### 2. Go to the MCP tab

Click **MCP** in the sidebar. Click **Add MCP Server**.

### 3. Enter the server URL

Paste the server's endpoint (e.g. `https://mcp.linear.app`). The UI runs OAuth discovery and shows the server's metadata.

### 4. Select a personality

The personality dropdown appears before the OAuth redirect. Select the personality that should hold the token (e.g. `engineer`). This determines the storage path for the credential.

### 5. Authorise

Click **Connect**. A new tab opens for the OAuth provider's consent screen. After you authorise, the tab closes and the token lands at the per-personality path.

### 6. Attach to the personality

If the server is not already in the personality's `mcp_servers:` list, the UI prompts to attach it. Confirm.

### 7. Test in chat

Navigate to the **Chat** tab, select the personality, and ask: "What MCP tools do you have?"

## Verify

Two checks confirm end-to-end setup:

1. **CLI**: `ethos personality show <id>` lists the server under "MCP servers" with a `connected` status.
2. **Chat**: `/personality <id>` then ask the agent to list its tools. The MCP tools appear with the `mcp__<name>__<tool>` prefix.

## Troubleshoot

**`MCP: 0 of N server(s) attached to "<personality>"`** — The server is defined in `mcp.json` but the personality's `config.yaml` has no `mcp_servers:` entry. Fix:

```bash
ethos personality mcp <id> --attach <name>
```

**`401 Unauthorized` on every MCP call** — The token is expired or was never acquired for this personality. Run the login step:

```bash
ethos mcp login <name> --personality <id>
```

**`Token file not found at personalities/<id>/mcp/<name>/access_token`** — The login step was run for a different personality, or the server uses a different name than expected. Check `ethos mcp list` for the registered name and re-run `login` with the correct `--personality` flag.

**Server not responding after OAuth** — The OAuth flow completed but the server itself is unreachable. Check `~/.ethos/logs/mcp/<name>.log` for connection errors. Verify the URL in `mcp.json` is correct and the server is running.

**Tools appear in `personality show` but not in chat** — The personality's `toolset.yaml` may filter out MCP tools. Either add the specific tool names (`mcp__<name>__<tool>`) to the toolset or omit the per-tool list to inherit everything the server exposes.

**Web UI shows no personality dropdown** — The dashboard requires at least one personality. Create one first:

```bash
ethos personality create engineer
```

Then reload the MCP tab.

## See also

- [MCP config reference](../reference/mcp-config.md) — field-by-field reference for `~/.ethos/mcp.json`, token storage, and the CLI workflow.
- [Use Ethos as an MCP server](use-as-mcp-server.md) — the inverse direction: exposing Ethos to MCP clients.
- [Personality config](../reference/personality-yaml.md) — the `mcp_servers:` attachment list in `config.yaml`.
- [Use the web dashboard](use-web-dashboard.md) — full guide to the web management surface, including the MCP tab.
