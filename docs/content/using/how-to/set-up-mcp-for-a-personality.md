---
title: "Set up MCP for a personality"
description: "Register an MCP server and attach it to a personality from the CLI, with web-dashboard and bearer-key variants in two further parts."
kind: how-to
audience: user
slug: set-up-mcp-for-a-personality
time: "10 min"
updated: 2026-11-05
---

## Task

Attach an MCP server to a specific [personality](../../getting-started/glossary.md#personality) so its tools are available in chat.

## Result

The personality can call the server's tools. Tokens are stored per-personality at `~/.ethos/personalities/<id>/mcp/<name>/` — no other personality inherits the credential.

## Parts

| Part | Covers |
|---|---|
| 1. CLI path (this page) | Register, log in, attach, verify and test from the terminal |
| [2. Web path](set-up-mcp-for-a-personality/web-path.md) | The same job from the web dashboard's MCP tab |
| [3. Bearer token servers](set-up-mcp-for-a-personality/bearer-token.md) | Servers that take a static API key and no OAuth |

## Prereqs

- `ethos` installed and a provider configured ([Configure an LLM provider](configure-providers.md)).
- At least one personality created (`ethos personality list` shows it).
- For OAuth-protected servers: either a browser on the machine running `ethos`, or any device with a browser (phone, laptop) for the code and paste sign-ins in step 2.
- For the web path: `ethos serve` running.

## Steps — CLI path

### 1. Register the server

```bash
ethos mcp add --url https://mcp.linear.app
```

This writes an entry to `~/.ethos/mcp.json`. No vulnerability scan runs, so check a community server's package yourself (see [OSV](../reference/mcp-config.md#osv)). No token is stored at this step — the server is defined but unauthenticated.

`ethos mcp add --url` takes the same `--device`, `--paste`, `--browser` and `--no-qr` flags. On a headless machine, or with `--device` or `--paste`, it saves the entry and then signs in once, so you skip step 2 for the personality that `ethos` resolves. If sign-in fails, the server stays added; run `ethos mcp login <name>` to retry.

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

#### Sign in on a headless machine

Over SSH, in a container, or on a Linux host with no display, the browser is on a different machine from `ethos`, so the redirect cannot reach it. `ethos mcp login` detects this (an `SSH_CONNECTION` or `SSH_TTY` variable, Linux with no `DISPLAY` or `WAYLAND_DISPLAY`, or a detected container) and uses a code sign-in instead of opening a browser. Force a flow with one flag:

| Flag | What happens |
|---|---|
| `--device` | Prints a code and a URL. Open the URL on any device and enter the code. `ethos` waits until you approve. |
| `--paste` | Prints an authorize URL. Open it anywhere, approve, then paste the address your browser ended on back into the terminal. |
| `--browser` | Opens a browser on this machine (the default on a desktop). |

Pass at most one. Add `--no-qr` to hide the QR code that `--device` prints.

```bash
ethos mcp login granola --device --personality engineer
```

```text
Sign in to 'granola' for personality 'engineer'
  server:              mcp.granola.ai
  authorization host:  mcp-auth.granola.ai
  open:                https://mcp-auth.granola.ai/device
  enter code:          ABCD-EFGH-J
  expires in:          4 min 59 s
Waiting… press Ctrl+C to cancel.
```

The code and its lifetime come from the server. When you approve, `ethos` prints `Successfully authenticated with 'granola' (personality: engineer)`.

If the server has no device sign-in (or refuses it for Ethos), `ethos` prints `Device sign-in is not available for '<name>' (...); using paste instead.` and switches to paste. Paste needs an interactive terminal; without one, the command exits with an error telling you to use `ssh -t` or `--browser` on a machine with a browser.

For paste, your browser ends on a `http://127.0.0.1:<port>/...` page that fails to load. Copy that address and paste it at the `>` prompt. It must contain `code=`. A wrong address gets a retry, up to three attempts.

Press Ctrl+C at any point to cancel. Nothing is stored and the command exits with code 130.

Provider support, checked 2026-10-18 against each preset's published metadata: only Granola offered the device grant to Ethos' dynamically registered client. Vercel advertised it but refused such clients. Linear, Notion, Asana and Sentry did not offer it. Use `--paste` for those. Providers change; if `--device` falls back to paste, the server does not support it today.

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

Use [part 2](set-up-mcp-for-a-personality/web-path.md) for the dashboard, or [part 3](set-up-mcp-for-a-personality/bearer-token.md) for a static API key.

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

**`Device sign-in is not available for '<name>' ... using paste instead`** — The server does not offer the device grant to Ethos. Paste the address your browser ends on at the `>` prompt, or run `ethos mcp login <name> --browser` on a machine with a browser.

**`The code expired before it was approved`** — Run `ethos mcp login <name> --device` again and enter the new code within the time shown.

**`Token file not found at personalities/<id>/mcp/<name>/access_token`** — The login step was run for a different personality, or the server uses a different name than expected. Run `ethos personality mcp <id>` to see the registered names (it lists every server in `mcp.json`) and re-run `login` with the correct `--personality` flag.

**Server not responding after OAuth** — The OAuth flow completed but the server itself is unreachable. Read the connection error in the output of the process running the agent. Ethos writes no per-server MCP log file. Verify the URL in `mcp.json` is correct and the server is running.

**Server appears in `personality show` but some of its tools are missing in chat** — `toolset.yaml` does not gate MCP tools, so it is not the cause. The personality's own `~/.ethos/personalities/<id>/mcp.yaml` narrows the server to a `tools:` list, or sets `enabled: false` for it. Add the bare tool name to `servers.<name>.tools`, or remove the server's entry to expose everything it lists. See [Tool naming](../reference/mcp-config.md#tool-naming).

## See also

- [MCP config reference](../reference/mcp-config.md) — field-by-field reference for `~/.ethos/mcp.json`, token storage, and the CLI workflow.
- [Use Ethos as an MCP server](use-as-mcp-server.md) — the inverse direction: exposing Ethos to MCP clients.
- [Personality config](../reference/personality-yaml.md) — the `mcp_servers:` attachment list in `config.yaml`.
- [Slash commands reference](../reference/slash-commands.md#slash-mcp) — `/mcp login` to sign in from a chat DM.
- [Use the web dashboard](use-web-dashboard.md) — full guide to the web management surface, including the MCP tab.
