---
title: "Set up MCP for a personality: bearer token servers"
description: "Register a static-key MCP server, attach it to a personality and set its token."
kind: how-to
audience: user
time: "4 min"
updated: 2026-11-03
---

## Task

Attach an MCP server that accepts a static API key, and store that key for one personality.

## Result

The token sits at `~/.ethos/personalities/<id>/mcp/<name>/access_token`, **Test connection** lists the server's tools, and the personality can call them.

## Prereqs

- Complete the prerequisites on [the main page](../set-up-mcp-for-a-personality.md): `ethos` installed, a provider configured and at least one personality.
- The server's API key.
- `ethos serve` running, for the **Set token** and **Test connection** controls.

## Steps — Bearer token servers

Bearer token servers accept a static API key with no OAuth consent screen. Skip the `mcp login` step entirely.

### 1. Register the server

Add the server to `~/.ethos/mcp.json` with `"auth": { "type": "bearer" }`. The entry needs no OAuth endpoints:

```json
{
  "name": "lookout",
  "transport": "streamable-http",
  "url": "https://lookout.example.com/mcp",
  "auth": { "type": "bearer" }
}
```

### 2. Attach the server to the personality

```bash
ethos personality mcp engineer --attach lookout
```

### 3. Set the token

Open the personality detail page in the web UI. The server row shows **Set token**. Paste the API key and confirm. The token is stored at:

```text
~/.ethos/personalities/engineer/mcp/lookout/access_token
```

To replace the token later, click **Update token** on the same row. The change takes effect on the next MCP request — no restart required.

### 4. Test

Click **Test connection** on the server row. A successful result lists the available tools. A `401` response means the token is wrong or has been rotated — update it with **Update token**.


## Verify

Run `ethos personality show <id>`. The server appears under "MCP servers" with a `connected` status. In chat, the MCP tools appear with the `mcp__<name>__<tool>` prefix.

## Troubleshoot

**Bearer server shows "Missing" in web UI** — No token is stored for this personality. Open the personality detail page and click **Set token** on the server row.

**`401 Unauthorized` on a bearer server** — The token is wrong or has been rotated. Open the personality detail page and click **Update token** to replace it.
