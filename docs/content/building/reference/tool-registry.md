---
title: "ToolRegistry reference"
description: "ToolRegistry interface, DefaultToolRegistry, executeParallel budget splitting, and per-personality tool gating."
kind: reference
audience: developer
slug: tool-registry
updated: 2026-05-12
---

The [tool registry](../../getting-started/glossary.md#tool-registry) is the catalogue of every [tool](../../getting-started/glossary.md#tool) the LLM may call. `AgentLoop` reads it twice per turn: once via `toDefinitions()` to build the LLM's tool list, and once via `executeParallel()` to run the calls the LLM made.

## Source {#source}

Interface in [`packages/types/src/tool.ts`](https://github.com/MiteshSharma/ethos/blob/main/packages/types/src/tool.ts) (`ToolRegistry`, `ToolFilterOpts`). Implementation in [`packages/core/src/tool-registry.ts`](https://github.com/MiteshSharma/ethos/blob/main/packages/core/src/tool-registry.ts) (`DefaultToolRegistry`).

## ToolRegistry {#tool-registry}

### Signature {#tool-registry-signature}

```ts
import type { Tool, ToolContext, ToolFilterOpts, ToolRegistry, ToolResult } from '@ethosagent/types';

export interface ToolRegistry {
  register(tool: Tool, opts?: { pluginId?: string }): void;
  registerAll(tools: Tool[]): void;
  unregister(name: string): void;
  get(name: string): Tool | undefined;
  getAvailable(): Tool[];
  getForToolset(toolset: string): Tool[];
  executeParallel(
    calls: Array<{ toolCallId: string; name: string; args: unknown }>,
    ctx: ToolContext,
    allowedTools?: string[],
    filterOpts?: ToolFilterOpts,
  ): Promise<Array<{ toolCallId: string; name: string; result: ToolResult }>>;
  toDefinitions(
    allowedTools?: string[],
    filterOpts?: ToolFilterOpts,
  ): ToolDefinitionLite[];
}
```

### Methods {#tool-registry-methods}

| Method | Description |
|---|---|
| `register(tool, opts?)` | Add a [`Tool`](./tool-interface.md) under `tool.name`. `opts.pluginId` tags the entry for per-[personality](../../getting-started/glossary.md#personality) plugin gating. |
| `registerAll(tools)` | Convenience wrapper that calls `register(t)` for each entry. |
| `unregister(name)` | Remove the tool with the given name. Used by `PluginApiImpl.cleanup` and tests. |
| `get(name)` | Look up a `Tool` by name. Returns `undefined` if missing. |
| `getAvailable()` | Return every registered tool whose `isAvailable()` returns true (or is absent). |
| `getForToolset(toolset)` | Filter `getAvailable()` to tools whose `toolset` field matches. |
| `executeParallel(calls, ctx, allowedTools?, filterOpts?)` | Run every call in parallel; see [below](#execute-parallel). |
| `toDefinitions(allowedTools?, filterOpts?)` | Produce the `ToolDefinitionLite[]` the LLM sees; see [below](#to-definitions). |

## ToolFilterOpts {#tool-filter-opts}

### Signature {#tool-filter-opts-signature}

```ts
export interface ToolFilterOpts {
  allowedMcpServers?: string[];
  allowedPlugins?: string[];
}
```

### Members {#tool-filter-opts-members}

| Field | Type | Description |
|---|---|---|
| `allowedMcpServers` | `string[]` | MCP-server allowlist. Tools named `mcp__<server>__*` are dropped unless their server name is in this list. `undefined` disables the filter. |
| `allowedPlugins` | `string[]` | Plugin allowlist. Tools registered with a `pluginId` are dropped unless that id is in this list. `undefined` lets every plugin tool through; `[]` strips all plugin tools. |

## toDefinitions {#to-definitions}

Returns the tool list the LLM sees. Built from three gates applied in order:

1. **`isAvailable()` gate** — tools that declare `isAvailable` and return `false` are dropped.
2. **Toolset gate** — applied only to built-in tools (name does not start with `mcp__` and no `pluginId`). When `allowedTools` is non-empty, a built-in tool must be in the list to pass. `alwaysInclude: true` bypasses this gate.
3. **`filterOpts` gate** — `allowedMcpServers` filters `mcp__<server>__*` tools; `allowedPlugins` filters plugin-tagged tools.

Surviving entries are mapped to `{ name, description, parameters: tool.schema }`.

### Why toolset gating only applies to built-ins {#why-built-in-only}

MCP and plugin tool names are dynamic — they appear and disappear as servers / plugins load. Requiring users to enumerate every MCP tool by name in `toolset.yaml` is unworkable. The two-tier model lets users gate built-ins by name and gate MCP / plugin tools wholesale via `mcp_servers` / `plugins`.

## executeParallel {#execute-parallel}

Runs every requested tool call in parallel. Returns results in input order. Throws never; failures become `{ ok: false }` `ToolResult`s.

### Per-call budget splitting {#per-call-budget}

```ts
const perCallBudget = Math.floor(ctx.resultBudgetChars / Math.max(calls.length, 1));
const budget = Math.min(perCallBudget, tool.maxResultChars ?? perCallBudget);
```

The turn-wide budget (`ctx.resultBudgetChars`, default 80,000) is split evenly across concurrent calls, then clamped by the tool's own `maxResultChars` ceiling. Each result is post-trimmed:

```
${value.slice(0, budget)}
[truncated — ${value.length} chars total]
```

See [tool-result-budget](../explanation/tool-result-budget.md) for the design rationale.

### Gating order {#gating-order}

For each call, `executeParallel` checks in order:

1. **Unknown tool** → `{ ok: false, code: 'not_available' }`.
2. **Built-in tool not in `allowedTools`** → `{ ok: false, code: 'not_available' }` with the message "is not permitted for this personality".
3. **Fails `filterOpts` (MCP server / plugin)** → `{ ok: false, code: 'not_available' }`.
4. **`isAvailable()` returns false** → `{ ok: false, code: 'not_available' }` with "is not currently available".
5. **`execute` throws** → `{ ok: false, code: 'execution_failed', error: err.message }`.
6. **Success exceeds budget** → trimmed with the `[truncated — N chars total]` marker.

Steps 1–4 mirror the `toDefinitions` gates so the LLM never sees a tool it cannot call, and `executeParallel` rejects rogue calls regardless (belt and suspenders against prompt injection).

## DefaultToolRegistry {#default-tool-registry}

The in-memory implementation `AgentLoop` uses. Internals worth knowing:

| Member | Description |
|---|---|
| `tools: Map<string, { tool, pluginId? }>` | Single source of truth. Keyed by `tool.name`. |
| `toolNamesForPersonality(personality)` | Helper used by the [skill](../../getting-started/glossary.md#skill) ingest filter. Returns the effective reach set: `personality.toolset` (built-ins) ∪ `mcp_servers` ∪ `plugins`. |

## Notes {#notes}

- `executeParallel` uses `Promise.allSettled`. A handler that throws never propagates — it's captured into `{ ok: false }`.
- `pluginId` on `register()` is what powers `unregisterPlugin` cleanup. Built-in tools are registered without it and cannot be removed by plugin unload.
- `alwaysInclude: true` on a `Tool` bypasses only the toolset gate. MCP and plugin filters still apply.
- `allowedTools = []` means "no built-ins allowed". `undefined` means "no filter". Pass `personality.toolset ?? undefined` to honour this.
- Per-call results are returned in input order regardless of which finished first. Consumers can rely on `results[i].toolCallId === calls[i].toolCallId`.
- The trim marker (`\n[truncated — N chars total]`) is appended only on success. Error `ToolResult`s carry whatever `error` string the tool returned, unmodified.

## Example: registering and invoking {#example}

```ts
import { DefaultToolRegistry } from '@ethosagent/core';
import { defineTool, ok } from '@ethosagent/plugin-sdk';

const registry = new DefaultToolRegistry();

registry.register(
  defineTool<{ q: string }>({
    name: 'echo',
    description: 'Return the query verbatim.',
    schema: {
      type: 'object',
      required: ['q'],
      properties: { q: { type: 'string' } },
    },
    async execute({ q }) {
      return ok(`echo: ${q}`);
    },
  }),
);

// What the LLM will see — filtered to the personality's toolset:
const defs = registry.toDefinitions(['echo']);

// What AgentLoop runs each round:
const results = await registry.executeParallel(
  [{ toolCallId: 't1', name: 'echo', args: { q: 'hello' } }],
  ctx,
  ['echo'],
);
```

## Used by {#used-by}

| Consumer | Role |
|---|---|
| `packages/core/src/agent-loop.ts` | Calls `toDefinitions` (LLM tool list) and `executeParallel` (each round of tool calls). |
| `apps/ethos/src/wiring.ts` | Registers every built-in tool from `extensions/tools-*` at startup. |
| `packages/plugin-sdk/src/index.ts` | `PluginApiImpl.registerTool` calls `register(tool, { pluginId })`. |
| `extensions/plugin-loader/src/` | Calls `unregister` during plugin deactivation. |
| `extensions/skills/src/` | Calls `toolNamesForPersonality` to validate skill `required_tools`. |
| `extensions/tools-mcp/src/index.ts` | Registers `mcp__<server>__*` tools on MCP-server discovery. |

## See also {#see-also}

- [Tool interface](./tool-interface.md) — what a `Tool` is.
- [Tool-result budget](../explanation/tool-result-budget.md) — how `maxResultChars` and `resultBudgetChars` interact.
- [Plugin SDK reference](./plugin-sdk.md) — registering tools from a plugin.
- [Glossary: ToolRegistry](../../getting-started/glossary.md#tool-registry) — one-line definition shared across the building tree.
