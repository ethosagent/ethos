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

1. **Configuration** — what servers Ethos *can* reach. Lives in `~/.ethos/mcp.json`, written by `ethos mcp add <name>`. Configured per machine, shared across personalities.
2. **Attachment** — which servers a *given personality* is allowed to use. Lives in the personality's `config.yaml` under `mcp_servers:`. Per personality, per repo.

A server has to be both configured *and* attached to the active personality before its tools show up in the agent loop. The boot-time log `MCP: 0 of N server(s) attached to "<personality>"` means the operator has configured servers but the personality has no `mcp_servers` allowlist — fix at the attachment layer.

## Step 1 — see what's configured

```bash
ethos personality mcp <personality-id>
```

This lists every server in `~/.ethos/mcp.json` and marks the ones attached to that personality with `[✓]`. There is no `ethos mcp list` command.

Each entry in `mcp.json` has at minimum a `name`, a `transport` (`stdio` | `streamable-http`), and the transport-specific config (`command` + `args` for stdio; `url` + optional `headers` for streamable-http).

## Step 2 — attach a server to a personality

```bash
ethos personality mcp <personality-id> --attach <server-name>
```

This appends `<server-name>` to `mcp_servers` in `~/.ethos/personalities/<id>/config.yaml`. The personality reloads on its next mtime check — no daemon restart needed.

Detach with `--detach <server-name>`. Check the current attachment set with `ethos personality mcp <personality-id>` again.

## Step 3 — verify the tools are reachable

After attach + a fresh turn:

```bash
ethos personality show <personality-id> | grep -A 5 'MCP'
```

The character sheet's `## MCP servers` section lists the servers attached to the personality by name. It does not list the tools each server exposes; those appear only once the server connects in a running turn. If a server is attached but its tools are missing, the server itself isn't returning a tool list — see Step 5.

## Step 4 — call an MCP tool

From the agent's perspective, MCP tools look like any other tool — they show up under the name `mcp__<server>__<tool>`. The LLM calls them by that exact name. The user doesn't usually invoke them directly; the personality's prompt should reference the *capability* ("read a file") and the model picks the right tool.

`toolset.yaml` does not gate MCP tools. Its allowlist applies to built-in tools only: `DefaultToolRegistry.toDefinitions` and `executeParallel` in `packages/core/src/tool-registry.ts` skip it for any `mcp__` name. Listing `mcp__<server>__<tool>` there neither grants nor narrows anything. By default, an attached server exposes every tool it lists; the `mcp_servers:` attachment is the gate.

To narrow an attached server to specific tools, or switch it off for this personality, write the personality's own `mcp.yaml` (`~/.ethos/personalities/<id>/mcp.yaml`, parsed by `parseMcpYaml` in `extensions/personalities/src/index.ts`). Use bare tool names:

```yaml
servers:
  filesystem:
    tools:
      - read_file
      - list_dir
  slack:
    enabled: false
```

The personality's definition files are operator-owned, so ask the user to make this edit. A server with no entry keeps all its tools. Pinned by `packages/core/src/__tests__/tool-registry-mcp-filter.test.ts`.

## Step 5 — debug a missing or broken MCP

A short checklist when an `mcp__<server>__<tool>` is unreachable:

| Symptom | Likely cause | Fix |
|---|---|---|
| `ethos personality mcp <id>` says no servers are configured, but `mcp.json` has entries | `mcp.json` is not valid JSON — the loader reads an unparseable file as empty, with no error message | Fix the JSON syntax |
| Server listed but `0 of N attached` warning | Personality has no `mcp_servers` allowlist | `ethos personality mcp <id> --attach <name>` |
| Server attached but no tools surface | Server failed to start | Read the connection error in the output of the process running the agent. Ethos writes no per-server MCP log file |
| 401 from a streamable-http server | Bearer token expired | Store a new one with `ethos personality mcp <id> --token-stdin <server>`, or update `headers` in `mcp.json` |
| `Cannot find package '@modelcontextprotocol/sdk'` | A workspace dep is missing | `pnpm install` from repo root |

## Anti-patterns

- **Configuring a server globally that one personality cares about.** Personalities have `mcp_servers:` for a reason — attach precisely.
- **Pasting tokens into `mcp.json` in plaintext.** Pass env values with `ethos mcp add <name> --env KEY=val`. The command stores each value in the secrets store and writes a `${secrets:<ref>}` reference into `mcp.json` (`storeEnvSecrets` in `extensions/tools-mcp/src/index.ts`). The reference is resolved when the server is spawned (`resolveEnvSecretRefs`, same file). This covers stdio `env` values only. For a bearer token, use `ethos personality mcp <id> --token-stdin <server>`.
- **Trying to restrict MCP tools through `toolset.yaml`.** It has no effect on `mcp__` tools. Restrict with `mcp_servers:` (per server) and the personality's `mcp.yaml` `tools:` list (per tool). A call outside those gates returns "Tool … is not permitted for this personality" (`executeParallel`, `packages/core/src/tool-registry.ts`).
- **Assuming community servers are vetted.** No Ethos command checks an MCP server's package against osv.dev. `checkOsvVulnerabilities` exists in `extensions/tools-mcp/src/osv-check.ts`, but nothing calls it. Check the package's advisories yourself before you add it.

## Hard rules

- **Server config is per-machine; attachment is per-personality.** Don't conflate them.
- **Secrets go through the resolver.** `${secrets:<ref>}` — never raw tokens in `mcp.json`.
- **Tool name format is `mcp__<server>__<tool>`.** Never edit that prefix; the runtime depends on it.

## Setup the user needs to do once

1. Add the servers they want available with `ethos mcp add <name>` (see `ethos mcp presets`), which writes `~/.ethos/mcp.json`.
2. Per personality, attach the relevant servers via `ethos personality mcp <id> --attach <name>`.
3. Verify with `ethos personality show <id>` — the character sheet lists the attached MCP servers.
