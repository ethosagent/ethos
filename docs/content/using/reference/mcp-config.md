---
title: "MCP config reference"
description: "Field-by-field reference for ~/.ethos/mcp.json: transports, OAuth 2.1, bearer token auth, env sandboxing, secret indirection, personality scoping."
kind: reference
audience: user
slug: mcp-config
updated: 2026-11-05
---


## Synopsis {#synopsis}

Ethos's MCP client reads servers from `~/.ethos/mcp.json`. The file is a **JSON array**; each entry is an `McpServerConfig`. Source of truth: [`McpServerConfig`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-mcp/src/index.ts) in `@ethosagent/tools-mcp`.

```json
[
  {
    "name": "filesystem",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/work"]
  },
  {
    "name": "github",
    "transport": "streamable-http",
    "url": "https://api.githubcopilot.com/mcp",
    "auth": {
      "type": "oauth2",
      "authorization_endpoint": "https://github.com/login/oauth/authorize",
      "token_endpoint": "https://github.com/login/oauth/access_token",
      "client_id": "Iv1.b507a08c87ecfe98"
    }
  }
]
```

Reload semantics: configuring a server here makes it **available**; it does not **attach** to any personality. See [Personality scoping](mcp-config/scoping-and-examples.md#scoping).

## Adding servers from the UI {#ui-flow}

The web UI offers a guided flow for OAuth-protected MCP servers: **Plugins → MCP Servers tab → Add MCP**. Before the OAuth redirect, the UI requires selecting a [personality](../../getting-started/glossary.md#personality) from the personality dropdown — tokens are stored per-personality, not globally. The modal handles OAuth discovery, dynamic client registration, and token storage automatically. Servers added through the UI are written to the same `~/.ethos/mcp.json` and are fully compatible with the CLI commands below.

## CLI workflow {#cli-workflow}

The CLI splits MCP setup into two steps: **define** the server, then **authenticate** per-personality.

### 1. Register the server {#register-server}

```bash
ethos mcp add --url https://mcp.linear.app
```

This runs OAuth discovery and writes an entry to `~/.ethos/mcp.json`, but stores **no token**. The server is now available to any personality that lists it in `mcp_servers:`, but unauthenticated calls will fail until a token is acquired.

### 2. Acquire a per-personality token {#acquire-token}

```bash
ethos mcp login linear --personality engineer
```

This runs the PKCE flow (opening a browser for OAuth servers) and stores the resulting token at the per-personality path: `~/.ethos/personalities/engineer/mcp/linear/access_token`. Each personality that needs access must run `login` separately — tokens are never shared across personalities.

Flags for `ethos mcp login <name>` and `ethos mcp add <name> --url <url>`:

| Flag | Applies to | Meaning |
|---|---|---|
| `--personality <id>` | `login` | Store the grant for that personality. |
| `--device` | both | Print a code and a URL; approve on any device ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628) device grant). |
| `--paste` | both | Print an authorize URL; paste back the `127.0.0.1` address the browser ends on. |
| `--browser` | both | Open a browser on this machine. |
| `--no-qr` | both | Do not print a QR code with `--device`. |

At most one of `--device`, `--paste`, `--browser` is accepted; two or more exit with `INVALID_INPUT`. With none, the flow is `device` when `SSH_CONNECTION` or `SSH_TTY` is set, when the platform is Linux with neither `DISPLAY` nor `WAYLAND_DISPLAY`, or when a container is detected. Otherwise it is `browser`. `device` falls back to `paste` when the server has no device endpoint or refuses the client. `paste` needs an interactive terminal. Ctrl+C stores nothing and exits with code 130. With `add --url`, `device` and `paste` sign in once after saving the entry; `browser` signs in during `add` as before.

Device and paste sign-ins store the same token files and issuer binding as the browser flow. Detection and flags: [`mcp.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/commands/mcp.ts) (`chooseLoginFlow`).

To revoke:

```bash
ethos mcp logout linear --personality engineer
```

This calls the revocation endpoint (if configured) and removes the stored token files.

## Signing in from the web and from chat {#remote-login}

| Surface | Entry point | Requirements |
|---|---|---|
| Web dashboard | **Sign in with a code** button on an OAuth server's row in the MCP tab. Shows the code, the verification URL and a countdown. | The server offers the device grant. Otherwise the modal says the server does not support code sign-in; use **Sign in**. |
| Chat (gateway) | `/mcp login <server>` in a direct message to the bot. See [`/mcp`](slash-commands.md#slash-mcp). | `channel_filter.<platform>.ownerUserId` set in `config.yaml`; server listed in the personality's `mcp_servers:`. |

Sources: [`McpDeviceLoginModal.tsx`](https://github.com/ethosagent/ethos/blob/main/apps/web/src/components/mcp/McpDeviceLoginModal.tsx), [`handleMcpCommand`](https://github.com/ethosagent/ethos/blob/main/extensions/gateway/src/index.ts).

## Server entry {#server-entry}

Every entry carries these fields. The `transport` choice gates which transport-specific fields apply.

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| `name` | string | — | yes | Stable id for this server. Tool names emit as `mcp__<name>__<tool>`. Reuse breaks the registry — keep unique. |
| `transport` | `'stdio' \| 'streamable-http' \| 'sse'` | — | yes | Subprocess vs HTTP. `sse` is deprecated and removed in the next minor — switch to `streamable-http`. |
| `keepaliveSeconds` | number | `30` | no | Period between ping frames; `0` disables. |
| `connectTimeoutMs` | number | `10000` | no | Initial handshake budget. Failed handshakes auto-reconnect with backoff. |
| `auth` | object | — | no | Auth block. `oauth2` or `bearer`. HTTP only. See [OAuth 2.1](mcp-config/auth-and-secrets.md#oauth), [Bearer auth](mcp-config/auth-and-secrets.md#bearer). |

### stdio fields {#stdio-fields}

Set on entries where `transport: "stdio"`.

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| `command` | string | — | yes | Executable. Resolved via `PATH` of the **sandboxed env** (see [Sandboxed environment](mcp-config/auth-and-secrets.md#sandbox)). |
| `args` | string[] | `[]` | no | Argument list passed to the subprocess. |
| `env` | Record\<string,string\> | `{}` | no | Extra env vars set on the subprocess. Always **merged** on top of the sandboxed env; pinned keys (`HOME`, `TMPDIR`, `XDG_*`) cannot be overridden — those are routed to a per-server scratch directory. |
| `mcpEnvPassthrough` | string[] | `[]` | no | Process env vars to forward through the sandbox. Required for credential-pattern names (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`) which are otherwise stripped. See [Sandboxed environment](mcp-config/auth-and-secrets.md#sandbox). |

### streamable-http fields {#http-fields}

Set on entries where `transport: "streamable-http"`.

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| `url` | string | — | yes | Server endpoint. Must be `https://`. |
| `headers` | Record\<string,string\> | `{}` | no | Request headers. Use `${secrets:<ref>}` for credentials — see [Secret indirection](mcp-config/auth-and-secrets.md#secrets). |

## Subpages {#subpages}

| Section | Page |
| --- | --- |
| <a id="oauth"></a>[OAuth 2.1](mcp-config/auth-and-secrets.md#oauth) | [MCP config: OAuth, bearer auth, sandbox and secrets](mcp-config/auth-and-secrets.md) |
| <a id="bearer"></a>[Bearer token auth](mcp-config/auth-and-secrets.md#bearer) | [MCP config: OAuth, bearer auth, sandbox and secrets](mcp-config/auth-and-secrets.md) |
| <a id="bearer-web"></a>[Setting the token via the web UI](mcp-config/auth-and-secrets.md#bearer-web) | [MCP config: OAuth, bearer auth, sandbox and secrets](mcp-config/auth-and-secrets.md) |
| <a id="bearer-vs-global"></a>[Per-personality vs global token](mcp-config/auth-and-secrets.md#bearer-vs-global) | [MCP config: OAuth, bearer auth, sandbox and secrets](mcp-config/auth-and-secrets.md) |
| <a id="sandbox"></a>[Sandboxed environment](mcp-config/auth-and-secrets.md#sandbox) | [MCP config: OAuth, bearer auth, sandbox and secrets](mcp-config/auth-and-secrets.md) |
| <a id="secrets"></a>[Secret indirection](mcp-config/auth-and-secrets.md#secrets) | [MCP config: OAuth, bearer auth, sandbox and secrets](mcp-config/auth-and-secrets.md) |
| <a id="scoping"></a>[Personality scoping](mcp-config/scoping-and-examples.md#scoping) | [MCP config: scoping, tool naming, examples and errors](mcp-config/scoping-and-examples.md) |
| <a id="tool-naming"></a>[Tool naming](mcp-config/scoping-and-examples.md#tool-naming) | [MCP config: scoping, tool naming, examples and errors](mcp-config/scoping-and-examples.md) |
| <a id="osv"></a>[OSV vulnerability scan (not implemented)](mcp-config/scoping-and-examples.md#osv) | [MCP config: scoping, tool naming, examples and errors](mcp-config/scoping-and-examples.md) |
| <a id="examples"></a>[Examples](mcp-config/scoping-and-examples.md#examples) | [MCP config: scoping, tool naming, examples and errors](mcp-config/scoping-and-examples.md) |
| <a id="example-filesystem"></a>[Filesystem (stdio, no credentials)](mcp-config/scoping-and-examples.md#example-filesystem) | [MCP config: scoping, tool naming, examples and errors](mcp-config/scoping-and-examples.md) |
| <a id="example-github"></a>[GitHub (stdio, token via passthrough)](mcp-config/scoping-and-examples.md#example-github) | [MCP config: scoping, tool naming, examples and errors](mcp-config/scoping-and-examples.md) |
| <a id="example-stripe"></a>[Stripe (HTTP, bearer via secret resolver)](mcp-config/scoping-and-examples.md#example-stripe) | [MCP config: scoping, tool naming, examples and errors](mcp-config/scoping-and-examples.md) |
| <a id="example-linear"></a>[Linear (HTTP, OAuth 2.1)](mcp-config/scoping-and-examples.md#example-linear) | [MCP config: scoping, tool naming, examples and errors](mcp-config/scoping-and-examples.md) |
| <a id="example-bearer"></a>[Lookout (HTTP, bearer token)](mcp-config/scoping-and-examples.md#example-bearer) | [MCP config: scoping, tool naming, examples and errors](mcp-config/scoping-and-examples.md) |
| <a id="errors"></a>[Common errors](mcp-config/scoping-and-examples.md#errors) | [MCP config: scoping, tool naming, examples and errors](mcp-config/scoping-and-examples.md) |

## See also {#see-also}

- [Set up MCP for a personality](../how-to/set-up-mcp-for-a-personality.md) — step-by-step walkthrough of the two-step CLI flow and the web OAuth path.
- [Use Ethos as an MCP server](../how-to/use-as-mcp-server.md) — the inverse: serving personalities to Claude Desktop, Cursor, Continue, Zed.
- [`native-mcp`](https://github.com/ethosagent/ethos/blob/main/skills/framework/native-mcp/SKILL.md) — bundled skill that wraps the operator workflow.
- [Config field reference](config-yaml.md) — `~/.ethos/config.yaml` and the `${secrets:<ref>}` pattern.
- [Personality config](personality-yaml.md) — the `mcp_servers:` attachment list.
- [`tools-mcp` source](https://github.com/ethosagent/ethos/blob/main/extensions/tools-mcp/src/index.ts) — `McpServerConfig` interface.
