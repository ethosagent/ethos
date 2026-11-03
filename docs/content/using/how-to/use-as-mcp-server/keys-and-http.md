---
title: "Use Ethos as an MCP server: keys, HTTP and running"
description: "Require a bearer key for an export, serve it over loopback HTTP, run it in the foreground."
kind: how-to
audience: user
time: "4 min"
updated: 2026-11-03
---

## Task

Require a per-client key on an exported personality, optionally serve it over HTTP, and run the server in the foreground.

## Result

Each client holds its own `sk-ethos-` key scoped to `mcp:<id>`, and `ethos mcp serve --personality <id>` prints a one-line summary on stderr and waits for requests.

## Prereqs

- Complete [part 2](export-a-personality.md): the personality declares `mcp_export.enabled: true`.
- `mcp_export.auth: bearer` in its `config.yaml` for a key or HTTP.

## Steps

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


## Verify

Run the server and read the summary.

```bash
ethos mcp serve --personality reviewer
```

```
exporting reviewer — tools: read_file, web_search · memory: none · conversations: off · auth: localhost (stdio)
```

With `mcp_export.auth: bearer` the last field reads `auth: bearer (stdio + HTTP)`.

## Troubleshoot

| Symptom | Cause and fix |
|---|---|
| A call comes back `busy`. | One `ask` per client runs at a time. Wait for the previous one; this is a concurrency bound, not a rate limit. |
| Garbled output in the client log. | Something wrote to stdout. Run the server directly and look for stray writes; a plugin's `console.log` breaks the channel. |
