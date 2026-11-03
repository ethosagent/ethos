---
title: "Use Ethos as an MCP server: manage an export from the dashboard"
description: "Inspect an export, create and revoke client keys, and read recent calls and denials."
kind: how-to
audience: user
time: "4 min"
updated: 2026-11-03
---

## Task

Manage one personality's MCP export from the web dashboard: see what a caller can reach, add and revoke clients, and read recent calls and denials.

## Result

The personality's **MCP export** section shows the resolved export, a one-time client key with a ready Claude Desktop entry, and the recent calls and refusals.

## Prereqs

- Complete [the export steps](export-a-personality.md) for a personality. Add client needs `mcp_export.auth: bearer`.
- The dashboard reachable on this machine.

## Steps

### 7. Manage the export from the web dashboard

The personality's page in the web dashboard shows the same resolved export as `ethos personality show`, plus the clients holding a key, their recent calls, and the calls that were refused. Start the dashboard:

```bash
ethos serve
```

It serves on port 3000 by default ([Use the web dashboard](../use-web-dashboard.md)). Open the personality's **Identity** pane (`/p/<id>/identity`) and scroll to **MCP export**. The section is `McpExportSection` (`apps/web/src/components/personality/McpExportSection.tsx`), fed by the `personalities.mcpExport` RPC (`PersonalitiesService.mcpExport`, `apps/web-api/src/services/personalities.service.ts`).

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


## Verify

Open `/p/<id>/identity` and scroll to **MCP export**. An exported personality shows the **Exported over MCP** pill and the same rows as `ethos personality show <id>`.

## Troubleshoot

| Symptom | Cause and fix |
|---|---|
| Add client is greyed out. | The export runs under `mcp_export.auth: localhost`, which checks no key. Set `mcp_export.auth: bearer` in `config.yaml`; the section re-reads the declaration on the next load. |
| A denial you expected is missing from Recent denials. | It fell outside the newest 500 events of its category. The events are still in the observability store: `ethos audit --category mcp.export.auth` (or `.discovery`, `.call`) lists them. |
