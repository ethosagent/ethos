---
title: "Tool interface reference"
description: "Tool, ToolResult, ToolContext, ToolResultReducer, and ToolResultReducerRegistry interfaces from @ethosagent/types."
kind: reference
audience: developer
slug: tool-interface
updated: 2026-11-03
---

The [tool](../../getting-started/glossary.md#tool) contract: what a tool must provide, how its results are shaped, and the reducer pipeline that trims output before it enters the context window.

## Source {#source}

[`packages/types/src/tool.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/tool.ts) and [`packages/types/src/tool-reducer.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/tool-reducer.ts). Re-exported from `@ethosagent/types`.

## Used by {#used-by}

| Consumer | Role |
|---|---|
| `extensions/tools-file/src/` | `read_file`, `write_file`, `patch_file`, `search_files`. |
| `extensions/tools-terminal/src/` | `terminal` (bash subprocess). |
| `extensions/tools-web/src/` | `web_search`, `fetch_url`. |
| `extensions/tools-browser/src/` | Playwright-driven `browser_*` tools. |
| `extensions/tools-code/src/` | `lint`, `typecheck`, `run_tests`. |
| `extensions/tools-memory/src/` | `memory_read`, `memory_write`, `session_search`. |
| `extensions/tools-todo/src/` | TODO list CRUD. |
| `extensions/tools-mcp/src/` | Bridges MCP-server tools into the registry. |
| `extensions/tools-delegation/src/` | `task` -- spawns subagents. |
| `packages/core/src/tool-registry.ts` | `DefaultToolRegistry.executeParallel` invokes `execute` for every `Tool` and applies `ToolResultReducer` to results. |
| `packages/plugin-sdk/src/tool-helpers.ts` | `defineTool<TArgs>` factory + `ok` / `err` `ToolResult` shorthands. |

## Subpages {#subpages}

| Section | Page |
| --- | --- |
| <a id="tool-result"></a>[ToolResult](tool-interface/tool-and-result.md#tool-result) | [Tool interface: Tool, ToolResult and ToolProgressEvent](tool-interface/tool-and-result.md) |
| <a id="tool-result-signature"></a>[Signature](tool-interface/tool-and-result.md#tool-result-signature) | [Tool interface: Tool, ToolResult and ToolProgressEvent](tool-interface/tool-and-result.md) |
| <a id="tool-result-success"></a>[Success variant](tool-interface/tool-and-result.md#tool-result-success) | [Tool interface: Tool, ToolResult and ToolProgressEvent](tool-interface/tool-and-result.md) |
| <a id="tool-result-error"></a>[Error variant](tool-interface/tool-and-result.md#tool-result-error) | [Tool interface: Tool, ToolResult and ToolProgressEvent](tool-interface/tool-and-result.md) |
| <a id="tool-result-error-codes"></a>[Error codes](tool-interface/tool-and-result.md#tool-result-error-codes) | [Tool interface: Tool, ToolResult and ToolProgressEvent](tool-interface/tool-and-result.md) |
| <a id="tool-result-notes"></a>[Notes](tool-interface/tool-and-result.md#tool-result-notes) | [Tool interface: Tool, ToolResult and ToolProgressEvent](tool-interface/tool-and-result.md) |
| <a id="tool-progress-event"></a>[ToolProgressEvent](tool-interface/tool-and-result.md#tool-progress-event) | [Tool interface: Tool, ToolResult and ToolProgressEvent](tool-interface/tool-and-result.md) |
| <a id="tool-progress-event-signature"></a>[Signature](tool-interface/tool-and-result.md#tool-progress-event-signature) | [Tool interface: Tool, ToolResult and ToolProgressEvent](tool-interface/tool-and-result.md) |
| <a id="tool-progress-event-members"></a>[Members](tool-interface/tool-and-result.md#tool-progress-event-members) | [Tool interface: Tool, ToolResult and ToolProgressEvent](tool-interface/tool-and-result.md) |
| <a id="tool-progress-event-notes"></a>[Notes](tool-interface/tool-and-result.md#tool-progress-event-notes) | [Tool interface: Tool, ToolResult and ToolProgressEvent](tool-interface/tool-and-result.md) |
| <a id="tool"></a>[Tool&lt;TArgs&gt;](tool-interface/tool-and-result.md#tool) | [Tool interface: Tool, ToolResult and ToolProgressEvent](tool-interface/tool-and-result.md) |
| <a id="tool-signature"></a>[Signature](tool-interface/tool-and-result.md#tool-signature) | [Tool interface: Tool, ToolResult and ToolProgressEvent](tool-interface/tool-and-result.md) |
| <a id="tool-members"></a>[Members](tool-interface/tool-and-result.md#tool-members) | [Tool interface: Tool, ToolResult and ToolProgressEvent](tool-interface/tool-and-result.md) |
| <a id="tool-notes"></a>[Notes](tool-interface/tool-and-result.md#tool-notes) | [Tool interface: Tool, ToolResult and ToolProgressEvent](tool-interface/tool-and-result.md) |
| <a id="tool-context"></a>[ToolContext](tool-interface/tool-context.md#tool-context) | [Tool interface: ToolContext and ToolFilterOpts](tool-interface/tool-context.md) |
| <a id="tool-context-signature"></a>[Signature](tool-interface/tool-context.md#tool-context-signature) | [Tool interface: ToolContext and ToolFilterOpts](tool-interface/tool-context.md) |
| <a id="tool-context-members"></a>[Members](tool-interface/tool-context.md#tool-context-members) | [Tool interface: ToolContext and ToolFilterOpts](tool-interface/tool-context.md) |
| <a id="tool-context-notes"></a>[Notes](tool-interface/tool-context.md#tool-context-notes) | [Tool interface: ToolContext and ToolFilterOpts](tool-interface/tool-context.md) |
| <a id="tool-filter-opts"></a>[ToolFilterOpts](tool-interface/tool-context.md#tool-filter-opts) | [Tool interface: ToolContext and ToolFilterOpts](tool-interface/tool-context.md) |
| <a id="tool-filter-opts-signature"></a>[Signature](tool-interface/tool-context.md#tool-filter-opts-signature) | [Tool interface: ToolContext and ToolFilterOpts](tool-interface/tool-context.md) |
| <a id="tool-filter-opts-members"></a>[Members](tool-interface/tool-context.md#tool-filter-opts-members) | [Tool interface: ToolContext and ToolFilterOpts](tool-interface/tool-context.md) |
| <a id="tool-reducer-context"></a>[ToolReducerContext](tool-interface/result-reducers.md#tool-reducer-context) | [Tool interface: ToolResultReducer and its registry](tool-interface/result-reducers.md) |
| <a id="tool-reducer-context-signature"></a>[Signature](tool-interface/result-reducers.md#tool-reducer-context-signature) | [Tool interface: ToolResultReducer and its registry](tool-interface/result-reducers.md) |
| <a id="tool-reducer-context-members"></a>[Members](tool-interface/result-reducers.md#tool-reducer-context-members) | [Tool interface: ToolResultReducer and its registry](tool-interface/result-reducers.md) |
| <a id="tool-result-reducer"></a>[ToolResultReducer](tool-interface/result-reducers.md#tool-result-reducer) | [Tool interface: ToolResultReducer and its registry](tool-interface/result-reducers.md) |
| <a id="tool-result-reducer-signature"></a>[Signature](tool-interface/result-reducers.md#tool-result-reducer-signature) | [Tool interface: ToolResultReducer and its registry](tool-interface/result-reducers.md) |
| <a id="tool-result-reducer-members"></a>[Members](tool-interface/result-reducers.md#tool-result-reducer-members) | [Tool interface: ToolResultReducer and its registry](tool-interface/result-reducers.md) |
| <a id="tool-result-reducer-notes"></a>[Notes](tool-interface/result-reducers.md#tool-result-reducer-notes) | [Tool interface: ToolResultReducer and its registry](tool-interface/result-reducers.md) |
| <a id="tool-result-reducer-registry"></a>[ToolResultReducerRegistry](tool-interface/result-reducers.md#tool-result-reducer-registry) | [Tool interface: ToolResultReducer and its registry](tool-interface/result-reducers.md) |
| <a id="tool-result-reducer-registry-signature"></a>[Signature](tool-interface/result-reducers.md#tool-result-reducer-registry-signature) | [Tool interface: ToolResultReducer and its registry](tool-interface/result-reducers.md) |
| <a id="tool-result-reducer-registry-members"></a>[Members](tool-interface/result-reducers.md#tool-result-reducer-registry-members) | [Tool interface: ToolResultReducer and its registry](tool-interface/result-reducers.md) |
| <a id="tool-result-reducer-registry-notes"></a>[Notes](tool-interface/result-reducers.md#tool-result-reducer-registry-notes) | [Tool interface: ToolResultReducer and its registry](tool-interface/result-reducers.md) |

## See also {#see-also}

- [ToolRegistry reference](./tool-registry.md) -- `executeParallel` and the reduction pipeline.
- [Why is there an 80k tool result budget?](../explanation/tool-result-budget.md)
- [Context cost optimization](../explanation/context-cost-optimization.md) -- the seven-layer defense.
- [Tool capabilities reference](./tool-capabilities.md)
- [Architecture in 90 seconds](../../getting-started/architecture-90-seconds.md)
