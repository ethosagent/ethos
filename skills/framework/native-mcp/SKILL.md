---
name: native-mcp
description: Use MCP (Model Context Protocol) servers from inside an Ethos personality. Connect to stdio or streamable-http servers, list their tools, call them safely, and understand the personality-scoped allowlist. The skill teaches MCP usage — Ethos's runtime already provides the client.
version: 1.0.0
author: ethosagent
tags: [ethos, mcp, integration]
required_tools: [terminal]

ethos:
  category: framework-usage
  default_personalities: [engineer, coordinator, operator]
  prerequisites:
    external_cli: []
    auth: []
    env_vars: []
    optional_tools: [read_file, write_file]
  integrates_with:
    - skill: github-auth
      role: example consumer — many MCP servers ship as gh-tokenised remote endpoints
  surface_metadata:
    invocation_trigger: "user says 'connect to <X> MCP server', 'use the filesystem MCP', 'why aren't MCP tools showing up?'; agent self-invokes when a tool call references an `mcp__` tool that isn't loaded for the active personality"
    estimated_turns: "1-3"
---

# Native MCP

Ethos ships an MCP client built into the runtime. This skill is the operator's guide to *using* it from a personality — what's configured, what's attached, what's reachable, and how to debug when a tool isn't showing up.

## When to use this skill

- A user asks "can we connect to the <X> MCP server?"
- A personality references `mcp__<server>__<tool>` and the agent can't find it.
- An operator runs `ethos personality mcp <id>` and is unsure which servers to attach.

## When NOT to use this skill

- Writing an MCP server. That's server-author work — out of scope here.
- The MCP server is fundamentally broken (won't start). Diagnose the server's own logs first.

## Mental model

MCP has two layers in Ethos:

1. **Configuration** — what servers Ethos *can* reach. Lives in `~/.ethos/mcp.yaml`. Configured per machine, shared across personalities.
2. **Attachment** — which servers a *given personality* is allowed to use. Lives in the personality's `config.yaml` under `mcp_servers:`. Per personality, per repo.

A server has to be both configured *and* attached to the active personality before its tools show up in the agent loop. The boot-time log `MCP: 0 of N server(s) attached to "<personality>"` means the operator has configured servers but the personality has no `mcp_servers` allowlist — fix at the attachment layer.

## Step 1 — see what's configured

```bash
cat ~/.ethos/mcp.yaml 2>/dev/null
# or
ethos mcp list
```

Each entry has at minimum a `name`, a `transport` (`stdio` | `streamable-http`), and the transport-specific config (`command` + `args` for stdio; `url` + optional `headers` for streamable-http).

## Step 2 — attach a server to a personality

```bash
ethos personality mcp <personality-id> --attach <server-name>
```

This appends `<server-name>` to `mcp_servers` in `~/.ethos/personalities/<id>/config.yaml`. The personality reloads on its next mtime check — no daemon restart needed.

Detach with `--detach <server-name>`. List the current attachment set with `ethos personality mcp <personality-id>`.

## Step 3 — verify the tools are reachable

After attach + a fresh turn:

```bash
ethos personality show <personality-id> | grep -A 5 'MCP'
```

The character sheet lists every MCP server the personality has access to and the tools each one exposes. If a server is attached but tools are missing, the server itself isn't returning a tool list — see Step 5.

## Step 4 — call an MCP tool

From the agent's perspective, MCP tools look like any other tool — they show up under the name `mcp__<server>__<tool>`. The LLM calls them by that exact name. The user doesn't usually invoke them directly; the personality's prompt should reference the *capability* ("read a file") and the model picks the right tool.

In a personality's `toolset.yaml`, you can opt into a specific MCP tool by name:

```yaml
- mcp__filesystem__read_file
- mcp__filesystem__list_dir
```

…or accept everything an attached server exposes by *not* listing them explicitly (the personality's `mcp_servers:` allowlist already gates access).

## Step 5 — debug a missing or broken MCP

A short checklist when an `mcp__<server>__<tool>` is unreachable:

| Symptom | Likely cause | Fix |
|---|---|---|
| Server in `mcp.yaml` but not in `ethos mcp list` | YAML parse error | `ethos mcp list --verbose` shows the parse error |
| Server listed but `0 of N attached` warning | Personality has no `mcp_servers` allowlist | `ethos personality mcp <id> --attach <name>` |
| Server attached but no tools surface | Server failed to start | Check `~/.ethos/logs/mcp/<server>.log` |
| Tool name resolves but the call hangs | Server is alive but the tool itself is slow | Run `ethos personality show <id>` and check the tool's declared `slow: true` flag |
| 401 from a streamable-http server | Bearer token expired | Re-issue and update `headers:` in `mcp.yaml` |
| `Cannot find package '@modelcontextprotocol/sdk'` | A workspace dep is missing | `pnpm install` from repo root |

## Anti-patterns

- **Configuring a server globally that one personality cares about.** Personalities have `mcp_servers:` for a reason — attach precisely.
- **Pasting tokens into `mcp.yaml` in plaintext.** Use `${secrets:<ref>}` indirection — Ethos's secret resolver substitutes at boot. The plaintext lives at `~/.ethos/secrets/<ref>` (mode 0600), not in the YAML.
- **Calling an MCP tool from a personality whose `toolset.yaml` doesn't allow it.** The tool registry filters by name; an unlisted tool returns "not available" at execute time.
- **Skipping the OSV check on community servers.** `ethos mcp` flags advisories from osv.dev for the server's package version. Don't ignore them.

## Hard rules

- **Server config is per-machine; attachment is per-personality.** Don't conflate them.
- **Secrets go through the resolver.** `${secrets:<ref>}` — never raw tokens in `mcp.yaml`.
- **Tool name format is `mcp__<server>__<tool>`.** Never edit that prefix; the runtime depends on it.
- **OSV findings are not advisory.** A `high` or `critical` advisory on a community server blocks the connection until rotated.

## Setup the user needs to do once

1. Write `~/.ethos/mcp.yaml` with the servers they want available.
2. Per personality, attach the relevant servers via `ethos personality mcp <id> --attach <name>`.
3. Verify with `ethos personality show <id>` — the character sheet lists the reachable MCP tools.
