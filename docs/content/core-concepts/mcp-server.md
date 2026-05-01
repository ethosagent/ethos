---
sidebar_position: 6
title: MCP Server
---

# MCP Server

Ethos exposes itself as a **Model Context Protocol (MCP) server** so any MCP-compatible client (Claude Desktop, Cursor, OpenCode, Continue, Zed) can call Ethos personalities, search memory, and trigger team workflows — without writing a custom integration.

> **Direction matters.** Ethos has long been able to *consume* third-party MCP servers (an Ethos personality can call any MCP tool — see [Adding tools](../extending-ethos/adding-tools.md)). The MCP server flips that direction: a third-party client calls *Ethos* as a tool. Same wire protocol, opposite role.

## What gets exposed

Each MCP primitive Ethos exposes:

### Tools (the client's LLM can invoke)

```
ask_personality(personality_id, prompt, [stream])
   → returns the personality's response (string or stream)

list_personalities()
   → returns the available personality roster + capabilities

search_memory(query, [scope])
   → returns matching entries from MEMORY.md / USER.md / personality memory
```

Each tool's input/output schema is auto-generated from the personality's `toolset.yaml` + `config.yaml`. You don't write JSON Schema; Ethos generates it.

### Resources (URI-addressable read-only data)

```
ethos://memory/MEMORY.md
ethos://memory/USER.md
ethos://personalities/<id>/ETHOS.md
ethos://personalities/<id>/config.yaml
ethos://sessions/<session-id>/transcript
ethos://sessions/recent
ethos://teams/<name>/manifest
```

### Prompts (pre-templated framings)

Ready-to-invoke prompt templates that wrap a personality with a specific framing — `code_review`, `research_topic`, `reflect_on_decision`, `debug_failure`. Surface in clients as slash-commands or quick-actions.

### Notifications (server → client streaming)

While a tool call runs, the server pushes:

- `agent.text_delta` — streaming response text
- `agent.thinking_delta` — extended thinking (when model supports)
- `agent.tool_start` / `agent.tool_end` — tool lifecycle
- `agent.usage` — token + cost so far

## Transport

**stdio only.** All target clients launch MCP servers as child processes and communicate via stdin/stdout JSON-RPC. Local-trust by definition — no auth, no TLS, no multi-tenancy.

The server entry point is [`ethos mcp serve`](../cli-reference.md#mcp). Logs go to **stderr** — anything stray on stdout corrupts JSON-RPC frames and crashes the client.

HTTP/SSE and WebSocket transports are **not supported** in v1.

## Quick install — Claude Desktop

```bash
# 1) Install Ethos (skip if already installed)
npm i -g @ethosagent/cli

# 2) Auto-write the MCP entry into Claude Desktop's config
ethos mcp install --client claude-desktop

# 3) Restart Claude Desktop
```

That's it. Open Claude Desktop and ask: "Ask the researcher: what's interesting in the current docs/ folder?"

For other clients:

```bash
ethos mcp install --client cursor
ethos mcp install --client opencode
ethos mcp install --client continue
ethos mcp install --client zed
```

## Verify it works

```bash
ethos mcp doctor          # config valid? handshake succeeds? tools resolve?
ethos mcp inspect         # interactive: list tools, invoke one, see raw response
```

`mcp doctor` is the right first step for any MCP support issue — it spawns the server, sends `initialize`, and reports which step failed.

## Manual config (advanced)

If `ethos mcp install` doesn't know your client, the entry shape is straightforward:

```json
{
  "mcpServers": {
    "ethos": {
      "command": "ethos",
      "args": ["mcp", "serve"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Drop this into your client's MCP config file. The exact path depends on the client — see [`examples/mcp-claude-desktop/`](https://github.com/ethosagent/ethos/tree/main/examples/mcp-claude-desktop) for one worked example, [`examples/mcp-custom-client/`](https://github.com/ethosagent/ethos/tree/main/examples/mcp-custom-client) for a minimal Node script that talks to the server directly.

## What's not exposed

Personalities whose toolsets aren't satisfiable through MCP (e.g. those requiring terminal access the client can't grant) are filtered out at handshake. The server tells the client only what it can actually serve. See `ethos mcp doctor` output for the specifics.

## What's deferred (not in v1)

- HTTP + SSE transport (and the auth / multi-tenancy that would come with it)
- WebSocket transport
- TypeScript / Python / Go SDKs (only meaningful with HTTP)
- Federation across multiple Ethos MCP servers
- A web admin UI for the MCP server

These come back when there's a specific customer need. Until then, stdio + npm install covers Claude Desktop / Cursor / OpenCode / Continue / Zed users — which is the named v1 audience.

## See also

- [`ethos mcp` CLI reference](../cli-reference.md#mcp)
- [Adding tools](../extending-ethos/adding-tools.md) — for the *consume* direction (Ethos calling MCP servers)
- [`examples/mcp-claude-desktop/`](https://github.com/ethosagent/ethos/tree/main/examples/mcp-claude-desktop)
- [`examples/mcp-custom-client/`](https://github.com/ethosagent/ethos/tree/main/examples/mcp-custom-client)
