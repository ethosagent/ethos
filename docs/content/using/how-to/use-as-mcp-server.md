---
title: "Use Ethos as an MCP server"
description: "Install the Ethos operator console into an MCP client; exporting one personality, keys and HTTP, and dashboard controls are separate parts."
kind: how-to
audience: user
slug: use-as-mcp-server
time: "10 min"
updated: 2026-11-03
---

## Task

Serve Ethos over the Model Context Protocol so an MCP client — Claude Desktop, Cursor, OpenCode, Continue, Zed — can reach it, either as the full operator console or as one exported [personality](../../getting-started/glossary.md#personality) (a directory of files that decides an agent's tools, memory, and model).

## Result

The client lists either the console's nine tools over your whole install, or a server named `ethos-<id>` with a single `ask` tool that runs one turn as that personality and nothing else.

## Parts

| Part | Covers |
|---|---|
| 1. Operator console (this page) | Step 1: install the console into a client and list its tools |
| [2. Export one personality](use-as-mcp-server/export-a-personality.md) | Steps 2-4: declare the export, check it, install it; what a caller can and cannot reach  |
| [3. Keys, HTTP and running](use-as-mcp-server/keys-and-http.md) | Steps 5-6: bearer key, loopback HTTP, foreground run |
| [4. Manage an export from the dashboard](use-as-mcp-server/dashboard.md) | Step 7: resolved export, client keys, revoke, recent calls and denials |

## Two servers, one subcommand

`ethos mcp serve` starts a different server depending on one flag. Pick before you install, because the two have different trust.

| | `ethos mcp serve` | `ethos mcp serve --personality <id>` |
|---|---|---|
| What it is | Operator console | One exported personality |
| Sees | Every personality, every [session](../../getting-started/glossary.md#session) (a stored conversation history) and memory key on the machine | One personality, one client's own conversations |
| Tools published | Nine, including `write_memory` | One — `ask`, plus two conversation tools when enabled |
| Caller picks the personality | Yes, per call | No — the server pins it |
| Auth | None. Loopback only | `localhost` (stdio) or a scoped `sk-ethos-` key |
| Turned on by | Installing it | `mcp_export.enabled: true` **and** running the command |

This page is Ethos as an MCP **server**. The opposite direction — Ethos calling *other* people's MCP servers through `mcp_servers` and `~/.ethos/mcp.json` — is a different feature: see [Set up MCP for a personality](set-up-mcp-for-a-personality.md).

## Prereqs

- `ethos` installed and a provider configured ([Configure an LLM provider](configure-providers.md)).
- `ethos --version` works in a fresh shell — the client spawns Ethos as a subprocess with a stripped environment.
- For an export: a personality you are willing to publish, and its `config.yaml`.

## Steps

### 1. Install the operator console

```bash
ethos mcp install claude-desktop
```

```
  Config: /Users/you/Library/Application Support/Claude/claude_desktop_config.json
✓ Installed Ethos MCP server into Claude Desktop
```

The adapters cover `claude-desktop`, `cursor`, `opencode`, `continue`, and `zed`. Each writes an `ethos` entry with absolute paths to your `node` binary and the `ethos` script. Restart the client afterwards — Claude Desktop caches the server list at launch.

The console publishes these [tools](../../getting-started/glossary.md#tool) (functions the calling model may invoke), plus resources and four prompt templates:

| Tool | What it does |
|---|---|
| `ask_personality` | Run one turn through a named personality. The reply is the first content block; the second is JSON carrying a `conversation` id to pass back. |
| `list_personalities` | The personality roster with descriptions and toolsets. |
| `list_sessions`, `get_session`, `get_messages`, `search_sessions` | Every session on the machine — by design, this surface is the operator console. |
| `search_memory`, `read_memory`, `write_memory` | One personality's [memory](../../getting-started/glossary.md#memory) (files the agent carries between sessions), through the same backend the agent uses. Writes are on. |

Resources are `ethos://memory/<id>/<key>`, `ethos://sessions/recent`, `ethos://personalities/<id>/SOUL.md` and `.../config.yaml`. Console sessions are keyed `mcp-console:<personality>:<conversation>`, so they never collide with an export's.

To see the roster without starting anything:

```bash
ethos mcp inspect
```

```
Tools:

  ask_personality     Run a prompt through a specific personality
  list_personalities  List all available personalities
```

(first two of nine, then the resources and prompts). `inspect` starts no server and prints the console's fixed roster — it says nothing about an export, which resolves per call.

`ask_personality` **collects** the turn and returns it as one result. Nothing streams to the client, and a refused turn (`BUDGET_EXCEEDED`, a watcher halt) comes back as an `isError` result carrying its code rather than as an empty answer — `collectTurnResult` in [`turn-result.ts`](https://github.com/ethosagent/ethos/blob/main/apps/mcp-server/src/turn-result.ts).
Continue with [part 2](use-as-mcp-server/export-a-personality.md) to export one personality instead.

## Verify

```bash
ethos mcp doctor
```

```
Ethos MCP doctor

  Node:   /usr/local/bin/node
  Script: /usr/local/lib/node_modules/@ethosagent/cli/dist/index.js
  Command: /usr/local/bin/node /usr/local/lib/node_modules/@ethosagent/cli/dist/index.js mcp serve

  [✓] Claude Desktop        /Users/you/Library/Application Support/Claude/claude_desktop_config.json
  [ ] Cursor                /Users/you/.cursor/mcp.json
```

`doctor` reports the spawn paths and which client configs exist. It does not read entry names, so confirm an export landed by opening the client and looking for `ethos-<id>`. Then ask that server something: a working round-trip returns the answer and a `conversation` id beside it.

## Troubleshoot

| Symptom | Cause and fix |
|---|---|
| The client starts but no Ethos tools appear. | The client resolved `ethos` with a stripped `PATH`. Re-run `ethos mcp install <client>`, which writes absolute paths. |
| `No ~/.ethos/config.yaml found.` | Run `ethos setup`. The error goes to stderr and the client surfaces it as a startup failure. |
| Two installs, the wrong one resolves. | The install writes the `node` binary that ran it. Re-run from the shell whose `ethos` you want, then restart the client. |

## See also

- [Set up MCP for a personality](set-up-mcp-for-a-personality.md) — the other direction: Ethos as an MCP client.
- [MCP configuration reference](../reference/mcp-config.md) — `~/.ethos/mcp.json` in full.
- [outbound_policy](../../building/reference/outbound-policy.md) — the other field that bounds what an agent may do on your behalf.
- [Use the web dashboard](use-web-dashboard.md) — starting `ethos serve` and finding a personality's page.
