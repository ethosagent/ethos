---
title: "Set up MCP for a personality: web path"
description: "Add an OAuth MCP server and attach it to a personality from the web dashboard."
kind: how-to
audience: user
time: "4 min"
updated: 2026-11-03
---

## Task

Add an OAuth-protected MCP server from the web dashboard and store its token under one personality.

## Result

The token lands at `~/.ethos/personalities/<id>/mcp/<name>/`, the server is in that personality's `mcp_servers:` list, and chat shows its tools.

## Prereqs

- Complete the prerequisites on [the main page](../set-up-mcp-for-a-personality.md): `ethos` installed, a provider configured and at least one personality.
- A browser reachable from the machine running `ethos`, for the OAuth consent screen.
- `ethos serve` running (step 1 starts it).

## Steps — Web path

### 1. Open the web dashboard

```bash
ethos serve
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

Run `ethos personality show <id>`. The server appears under "MCP servers" with a `connected` status. In chat, the MCP tools appear with the `mcp__<name>__<tool>` prefix.

## Troubleshoot

**Web UI shows no personality dropdown** — The dashboard requires at least one personality. Create one first:

```bash
ethos personality create engineer
```

Then reload the MCP tab.
