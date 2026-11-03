---
title: "MCP config: OAuth, bearer auth, sandbox and secrets"
description: "MCP server OAuth, bearer auth, sandbox and secret indirection."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

How an MCP server entry authenticates and what environment it sees. Part of the [MCP config reference](../mcp-config.md).

## OAuth 2.1 {#oauth}

Servers that require an authorization flow declare an `auth` block. Ethos walks the MCP SDK's PKCE flow on first connect, persists tokens through `SecretsResolver`, and refreshes silently on expiry. Re-auth in the browser is required only when refresh itself fails.

```json
{
  "name": "linear",
  "transport": "streamable-http",
  "url": "https://mcp.linear.app",
  "auth": {
    "type": "oauth2",
    "authorization_endpoint": "https://linear.app/oauth/authorize",
    "token_endpoint": "https://api.linear.app/oauth/token",
    "client_id": "<your-app-client-id>",
    "scopes": ["read", "write"],
    "revocation_endpoint": "https://api.linear.app/oauth/revoke"
  }
}
```

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| `type` | `'oauth2'` | — | yes | The only value today. |
| `authorization_endpoint` | string | — | yes | Authorization server's `/authorize` URL. |
| `token_endpoint` | string | — | yes | Token exchange + refresh URL. |
| `client_id` | string | — | yes | Public client identifier registered with the server. |
| `scopes` | string[] | `[]` | no | Scopes to request at authorize time. |
| `revocation_endpoint` | string | — | no | RFC 7009 revocation endpoint. Used when the operator runs `ethos mcp logout <name>`. |

Token storage paths (per-personality, owner-only 0600):

| Path | Contents |
|---|---|
| `~/.ethos/personalities/<id>/mcp/<name>/access_token` | Current bearer token |
| `~/.ethos/personalities/<id>/mcp/<name>/refresh_token` | Refresh credential (when issued) |
| `~/.ethos/personalities/<id>/mcp/<name>/expires_at` | RFC 3339 expiry timestamp |

Tokens are scoped to each personality. Two personalities using the same MCP server hold independent tokens — revoking one does not affect the other.

Source of truth: [`oauth.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-mcp/src/oauth.ts).

## Bearer token auth {#bearer}

Servers that accept a static API key use `auth.type: "bearer"`. Ethos reads the token from the personality's secrets store and attaches it as `Authorization: Bearer <token>` on every request. There is no browser flow and no refresh loop — update the token file and it takes effect on the next MCP request.

```json
{
  "name": "lookout",
  "transport": "streamable-http",
  "url": "https://lookout.example.com/mcp",
  "auth": { "type": "bearer" }
}
```

Token storage path (per-personality, owner-only 0600):

| Path | Contents |
|---|---|
| `~/.ethos/personalities/<id>/mcp/<name>/access_token` | API key |

### Setting the token via the web UI {#bearer-web}

Open the personality detail page. Each bearer-auth server row shows **Set token** (when no token is stored) or **Update token** (when one exists). Paste the key and confirm. The connection status updates on the next status poll; no daemon restart is needed.

### Per-personality vs global token {#bearer-vs-global}

The `auth.type: "bearer"` pattern and the `headers` secret-indirection pattern both send the same `Authorization` header — they differ in where the token resolves from.

| Pattern | Token path | Scope |
|---|---|---|
| `auth.type: "bearer"` | `personalities/<id>/mcp/<name>/access_token` | Per-personality. Independent tokens per personality. |
| `headers: { Authorization: "Bearer ${secrets:ref}" }` | `secrets/<ref>` | Global. All personalities share one token. |

Use `auth.type: "bearer"` when different personalities need separate API keys for the same server. Use the `headers` pattern when a single key covers all personalities.

## Sandboxed environment {#sandbox}

stdio servers run with a **minimal env**, not the operator's full process env. The default allowlist is `PATH`, `USER`, `LANG`, `LC_ALL`, `TERM`, `SHELL`. Everything else is stripped before the server starts.

Additional rules applied by `buildMcpEnv` in [`@ethosagent/safety-scanner`](https://github.com/ethosagent/ethos/blob/main/packages/safety/scanner/src/mcp-env.ts):

1. **Credential-pattern strip.** Any var whose name matches `(^|_)(KEY|TOKEN|SECRET|PASSWORD)($|_)` (case-insensitive) is removed unless explicitly listed in `mcpEnvPassthrough`. `API_KEY` and `OPENAI_API_KEY` are stripped; `KEYSTONE` and `MASTODON` are kept.
2. **Pinned scratch dirs.** `HOME`, `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` are pinned to `~/.ethos/mcp-runtime/<name>/` (mode 0700). The subprocess cannot read `~/.aws`, `~/.ssh`, `~/.npmrc`, or any other dotfile from the operator's real home.
3. **Per-server isolation.** Each server's scratch dir is distinct — `filesystem` cannot read `~/.ethos/mcp-runtime/github/`.

To grant a credential to a stdio server, name it explicitly:

```json
{
  "name": "github",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "mcpEnvPassthrough": ["GITHUB_PERSONAL_ACCESS_TOKEN"]
}
```

The token still has to exist in the operator's env at runtime; `mcpEnvPassthrough` just stops Ethos from stripping it.

## Secret indirection {#secrets}

Never inline plaintext credentials in `mcp.json`. Use `${secrets:<ref>}` — Ethos's `SecretsResolver` substitutes the value at boot, reading plaintext from `~/.ethos/secrets/<ref>` (mode 0600, parent dir 0700).

```json
{
  "name": "stripe",
  "transport": "streamable-http",
  "url": "https://mcp.stripe.com",
  "headers": {
    "Authorization": "Bearer ${secrets:stripe/api_key}"
  }
}
```

Store the secret with:

```bash
ethos secrets set stripe/api_key sk_live_…
```

The resolver is lenient: a value that doesn't match the `${secrets:<ref>}` pattern is returned as-is. That means raw plaintext "works" — but it's a bug to ship config that way. See the [Config field reference](../config-yaml.md) for the broader pattern.

## See also {#see-also}

- [MCP config reference](../mcp-config.md): the index of every section and its page.
