---
title: "Use Ethos as an MCP server: export one personality"
description: "Declare an mcp_export on one personality, check it, and install it into a client."
kind: how-to
audience: user
time: "5 min"
updated: 2026-11-03
---

## Task

Export one personality to an MCP client as a single `ask` tool: declare the export, check what it resolved to, and install it.

## Result

The client lists a server named `ethos-<id>` with one `ask` tool that runs a turn as that personality and nothing else.

## Prereqs

- Read [Two servers, one subcommand](../use-as-mcp-server.md#two-servers-one-subcommand) to confirm you want an export and not the console.
- `ethos --version` works in a fresh shell, and a personality you are willing to publish with its `config.yaml`.

## Steps

### 2. Declare an export on one personality

Add flat dotted keys to `~/.ethos/personalities/<id>/config.yaml`:

```yaml
mcp_export.enabled: true
mcp_export.expose_tools: read_file web_search
mcp_export.expose_memory: none
mcp_export.expose_sessions: false
mcp_export.auth: localhost
```

What each key means, its default and its vocabulary are in the [`mcp_export.*` reference](../../reference/personality-yaml.md#mcp-export). Every key fails closed: `enabled` must be the literal `true`, and a value outside a key's vocabulary leaves the default (`expose_memory: Scoped` resolves to `none`). `expose_tools` names what the exported turn may use; it is never published to the caller, and it only narrows this personality's reach.

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

Print the resolved export.

```bash
ethos personality show reviewer
```

The output has an `## MCP export` block whose first line reads `- Status: exported`. Then open the client and look for `ethos-reviewer`.

## Troubleshoot

| Symptom | Cause and fix |
|---|---|
| The export lists no tools at all. | A withdrawn export publishes nothing rather than advertising a tool it would refuse. So `mcp_export.enabled` is not literally `true`, the personality is gone, or the key was refused. Run `ethos personality show <id>` and read the Status line. |
| `export_disabled` on stderr, exit 1. | The same cause at startup. Serve and install read the declaration through the same resolver, so the two cannot disagree. |
| A tool the export should have is missing. | It was dropped. `expose_tools` intersects with the personality's own toolset, MCP servers and plugins; add it there first, then to `expose_tools`. |
