---
title: "Use Ethos as an MCP server"
description: "Serve the full operator console to an MCP client, or export one personality as a single ask tool bounded by its own declaration."
kind: how-to
audience: user
slug: use-as-mcp-server
time: "10 min"
updated: 2026-09-13
---

## Task

Serve Ethos over the Model Context Protocol so an MCP client — Claude Desktop, Cursor, OpenCode, Continue, Zed — can reach it, either as the full operator console or as one exported [personality](../../getting-started/glossary.md#personality) (a directory of files that decides an agent's tools, memory, and model).

## Result

The client lists either the console's nine tools over your whole install, or a server named `ethos-<id>` with a single `ask` tool that runs one turn as that personality and nothing else.

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

### 2. Declare an export on one personality

Add flat dotted keys to `~/.ethos/personalities/<id>/config.yaml`:

```yaml
mcp_export.enabled: true
mcp_export.expose_tools: read_file web_search
mcp_export.expose_memory: none
mcp_export.expose_sessions: false
mcp_export.auth: localhost
```

What each key means, its default and its vocabulary are in the [`mcp_export.*` reference](../reference/personality-yaml.md#mcp-export). Every key fails closed: `enabled` must be the literal `true`, and a value outside a key's vocabulary leaves the default (`expose_memory: Scoped` resolves to `none`). `expose_tools` names what the exported turn may use; it is never published to the caller, and it only narrows this personality's reach.

### 3. Check what the export resolved to

```bash
ethos personality show reviewer
```

```
## MCP export
- Status: exported — `ethos mcp serve --personality reviewer`
- Caller's turn may use: read_file, web_search
    - terminal — dropped, not in this personality's reach
- Memory: none — no prefetch, no memory tools
- Conversations: not exposed
- Auth: localhost — stdio only; the boundary is whoever can spawn ethos as this OS user
- No rate limit: an admitted client may call as often as it likes. What bounds the cost is
  budgetCapUsd per session key, one in-flight call per client, and revoking the key.
- Loopback only, no TLS: HTTP binds 127.0.0.1 and the traffic is not encrypted. A remote
  caller needs the operator's own TLS-terminating proxy.
```

Read the dropped line. `expose_tools` only narrows what the personality already has, so a name printed there was never granted, and the export is running without it.

### 4. Install the export into a client

```bash
ethos mcp install claude-desktop --personality reviewer
```

```
  Config: /Users/you/Library/Application Support/Claude/claude_desktop_config.json
✓ Installed ethos-reviewer into Claude Desktop
  exporting reviewer — tools: read_file, web_search · memory: none · conversations: off · auth: localhost (stdio)
```

The entry is named `ethos-reviewer`, so it lands beside any `ethos` console entry instead of replacing it. In the client you get a server called `ethos-reviewer` with one tool, `ask`, described by the personality's own `description`.

Refusals are loud. An unknown id, or an `enabled` that is not literally `true`, exits 1 with one JSON line on stderr and starts nothing:

```
{"level":"error","code":"export_disabled","msg":"Personality \"reviewer\" does not declare mcp_export.enabled: true, so it is not exported over MCP."}
```

### 5. Require a key, or serve it over HTTP

Set `mcp_export.auth: bearer` and re-run the install. It mints the client's key into the entry's `ETHOS_MCP_KEY` and prints only the prefix:

```
  Config: /Users/you/Library/Application Support/Claude/claude_desktop_config.json
✓ Installed ethos-reviewer into Claude Desktop
  exporting reviewer — tools: read_file, web_search · memory: none · conversations: off · auth: bearer (stdio + HTTP)
  Client key: sk-ethos-a1b2c3d4  (written to the entry's ETHOS_MCP_KEY)
  Revoke with: ethos api-key revoke sk-ethos-a1b2c3d4
```

For a client you configure by hand, mint one yourself — one key per client, scoped to this export:

```bash
ethos api-key create --name "cursor — reviewer" --scopes mcp:reviewer
```

```
✓ API key created  name: cursor — reviewer

  sk-ethos-a1b2c3d4e5f6...

  prefix: sk-ethos-a1b2c3d4
  scopes: mcp:reviewer

  This is the only time the full key is shown. Save it now.
```

A key is verified at initialize and again on every call, so `ethos api-key revoke <prefix>` locks that client out on its next call — no restart, and no other client affected. A key minted for a different export or a different surface is refused by the same check.

Bearer also unlocks HTTP:

```bash
ethos mcp serve --personality reviewer --http --port 3310
```

```
exporting reviewer — tools: read_file, web_search · memory: none · conversations: off · auth: bearer (stdio + HTTP)
```

Requests carry `Authorization: Bearer sk-ethos-…` to `http://127.0.0.1:3310/mcp`. The listener binds loopback only and answers 403 to any other `Host` header; each session id is bound to the key that opened it, so a second key cannot resume it. A `localhost` export refuses HTTP outright rather than binding a port.

### 6. Run a server in the foreground

```bash
ethos mcp serve --personality reviewer
```

```
exporting reviewer — tools: read_file, web_search · memory: none · conversations: off · auth: localhost (stdio)
```

Both servers speak JSON-RPC on stdin/stdout. Every log line, the summary above and every refusal go to stderr — anything stray on stdout corrupts the frame and the client disconnects.

### 7. Manage the export from the web dashboard

The personality's page in the web dashboard shows the same resolved export as `ethos personality show`, plus the clients holding a key, their recent calls, and the calls that were refused. Start the dashboard:

```bash
ethos serve --web
```

It serves on port 3000 by default ([Use the web dashboard](use-web-dashboard.md)). Open the personality's **Identity** pane (`/p/<id>/identity`) and scroll to **MCP export**. The section is `McpExportSection` (`apps/web/src/components/personality/McpExportSection.tsx`), fed by the `personalities.mcpExport` RPC (`PersonalitiesService.mcpExport`, `apps/web-api/src/services/personalities.service.ts`).

**See what a caller can reach.** A personality whose `mcp_export.enabled` is not literally `true` shows a **Not exported** pill and names the key and its `config.yaml`. An exported one shows **Exported over MCP** and the slice `resolveMcpExportScope` resolved — the same resolver the server runs on every call:

| Row | What it shows |
|---|---|
| Caller's turn may use | One chip per tool the exported turn may use. A name in `expose_tools` outside this personality's toolset is struck through, with a line saying it is dropped rather than granted. `none — conversation only` when nothing is exposed |
| Memory | `none`, `scoped` or `full`, with what each withholds |
| Conversations | Whether `list_conversations` and `get_conversation` are published, over the calling client's own conversations only |
| Auth | `bearer` (stdio + HTTP, loopback only) or `localhost` (stdio only, no key checked) |
| Command | `ethos mcp serve --personality <id>` |

Below the rows, a notice says the declaration is read-only here and names every `mcp_export.*` key to edit in `config.yaml`. The page never writes the declaration.

**Add a client and copy its Claude Desktop entry.** **Add client** is enabled only under `mcp_export.auth: bearer`; under `localhost` the page says so and shows a key-less Claude Desktop entry instead. Name the client and press **Create key**. The page mints a key scoped `mcp:<id>` through `apiKeys.create` and shows it once:

```
NEW CLIENT — SHOWN ONCE
Copy this now. Ethos stores only its hash and cannot show it again.
sk-ethos-a1b2c3d4e5f6...
```

Beneath the key is a **Claude Desktop entry** with that key already in `ETHOS_MCP_KEY`:

```json
{
  "mcpServers": {
    "ethos-reviewer": {
      "command": "/usr/local/bin/node",
      "args": ["/usr/local/lib/node_modules/@ethosagent/cli/dist/index.js", "mcp", "serve", "--personality", "reviewer"],
      "env": { "ETHOS_MCP_KEY": "sk-ethos-a1b2c3d4e5f6..." }
    }
  }
}
```

The server builds it with `claudeDesktopExportEntry` (`apps/ethos/src/commands/mcp-export.ts`), which calls the same `buildExportEntry` that `ethos mcp install` writes, so the two cannot disagree. The server sends a placeholder, and your browser swaps in the key, which never leaves it except in the `apiKeys.create` response. Paste the `ethos-<id>` entry into `mcpServers` in `claude_desktop_config.json` and restart Claude Desktop. The `command` and `args` are the Node binary and CLI script running `ethos serve`, so copy the entry from a dashboard on the machine where Claude Desktop runs. Press **Done** to drop the key from the page.

**Revoke a client.** The **Clients** table lists every unrevoked key carrying `mcp:<id>`, by name, key prefix, creation date and last use. **Revoke** asks for confirmation — "Its next call is refused. A revoked key cannot be restored." — then calls `apiKeys.revoke`. The server re-verifies the key on every call, so the client is locked out on its next one.

**Read recent calls and denials.** **Recent external calls** lists the last 20 sessions with `platform = mcp` whose key starts `mcp:<id>:`, with the client, conversation title, cost and an **Open** button into the transcript. **Recent denials** lists the newest 20 refusals recorded under `mcp.export.auth`, `mcp.export.discovery` and `mcp.export.call` for this personality, with the client and the reason code.

Two limits on those tables:

- **Denials come from a fixed window.** The event store filters by category, not by personality, so the service reads the newest 500 events in each of the three categories on the machine and keeps this personality's afterwards (`MCP_EXPORT_EVENT_SCAN`). A denial pushed out of that window by other exports' traffic is not shown, even though it happened.
- **An empty table is not proof of nothing.** Each source fails soft: a missing or throwing event store, session store or key store empties its table rather than failing the section.

## What an exported caller can and cannot reach

| Can a caller of `ask`… | Answer | Enforced by |
|---|---|---|
| choose which personality answers? | No | The server pins `personalityId`, and `ask`'s schema has no such parameter — `PersonalityExportServer` in [`export-server.ts`](https://github.com/ethosagent/ethos/blob/main/apps/mcp-server/src/export-server.ts) |
| call `read_file`, or any tool, directly? | No | `ask` runs a whole turn. `expose_tools` names what that turn may use; those tools are never published as MCP tools |
| use a tool outside `expose_tools`? | No | `resolveMcpExportScope` passes `toolsetNarrow` **and** the complement as `toolsetExclude`, which is what also bounds `mcp__*`, plugin and always-included tools |
| reach another personality's memory, a team's, or `user:<id>`? | No | The turn's memory scope is fixed at `personality:<id>` in `setupTurn`, and the export never sets a user id |
| read memory as an MCP resource? | No | The export server's capabilities are `{ tools: {} }` — no resources, no prompts |
| read your CLI or console sessions? | No | The conversation tools filter on the server-built prefix `mcp:<id>:<client>:` |
| run a tool that needs approval? | No | Approval fails closed here — there is nobody at an MCP transport to ask — so the call is rejected with "requires approval; unavailable over MCP export" rather than queued or waved through. Under `safety.approvalMode: smart` a call the reviewer approves raises no objection and proceeds |
| teach the agent something permanent? | No | The export process disables post-turn learning, so an external client's text never becomes your memory or skills. An explicit `memory_write` under `expose_memory: full` is the exception, and it is visible in the transcript |
| call as often as it likes? | **Yes** | Nothing rate-limits it. `budgetCapUsd` per session key, one in-flight call per client, and revoking the key are what bound the cost |

Two limits beyond the table, stated because the shape of the feature implies otherwise. The reviewer of an exported call is the personality's own SOUL and toolset — no separate filter reads the request. And under `auth: localhost`, two stdio clients that report the same name to the server share a session prefix, and so each other's conversations; both already run as the same OS user.

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
| The export lists no tools at all. | A withdrawn export publishes nothing rather than advertising a tool it would refuse. So `mcp_export.enabled` is not literally `true`, the personality is gone, or the key was refused. Run `ethos personality show <id>` and read the Status line. |
| `export_disabled` on stderr, exit 1. | The same cause at startup. Serve and install read the declaration through the same resolver, so the two cannot disagree. |
| A call comes back `busy`. | One `ask` per client runs at a time. Wait for the previous one; this is a concurrency bound, not a rate limit. |
| A tool the export should have is missing. | It was dropped. `expose_tools` intersects with the personality's own toolset, MCP servers and plugins; add it there first, then to `expose_tools`. |
| Garbled output in the client log. | Something wrote to stdout. Run the server directly and look for stray writes; a plugin's `console.log` breaks the channel. |
| `No ~/.ethos/config.yaml found.` | Run `ethos setup`. The error goes to stderr and the client surfaces it as a startup failure. |
| Add client is greyed out. | The export runs under `mcp_export.auth: localhost`, which checks no key. Set `mcp_export.auth: bearer` in `config.yaml`; the section re-reads the declaration on the next load. |
| A denial you expected is missing from Recent denials. | It fell outside the newest 500 events of its category. The events are still in the observability store: `ethos audit --category mcp.export.auth` (or `.discovery`, `.call`) lists them. |
| Two installs, the wrong one resolves. | The install writes the `node` binary that ran it. Re-run from the shell whose `ethos` you want, then restart the client. |

## See also

- [Set up MCP for a personality](set-up-mcp-for-a-personality.md) — the other direction: Ethos as an MCP client.
- [MCP configuration reference](../reference/mcp-config.md) — `~/.ethos/mcp.json` in full.
- [outbound_policy](../../building/reference/outbound-policy.md) — the other field that bounds what an agent may do on your behalf.
- [Use the web dashboard](use-web-dashboard.md) — starting `ethos serve --web` and finding a personality's page.
