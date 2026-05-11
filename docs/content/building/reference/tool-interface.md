---
title: "Tool interface"
description: "Tool<TArgs>, ToolResult, and ToolContext — the three types every Ethos tool implements."
kind: reference
audience: developer
slug: tool-interface
updated: 2026-05-12
---

A [tool](../../getting-started/glossary.md#tool) is a `Tool<TArgs>` object registered with the [tool registry](./tool-registry.md). The LLM sees its `name`, `description`, and `schema`; the framework invokes `execute(args, ctx)` and renders the returned `ToolResult`.

## Source {#source}

Defined in [`packages/types/src/tool.ts`](https://github.com/MiteshSharma/ethos/blob/main/packages/types/src/tool.ts). Re-exported from `@ethosagent/types`.

## Tool {#tool}

### Signature {#tool-signature}

```ts
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';

export interface Tool<TArgs = unknown> {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  toolset?: string;
  maxResultChars?: number;
  execute: (args: TArgs, ctx: ToolContext) => Promise<ToolResult>;
  isAvailable?: () => boolean;
  alwaysInclude?: boolean;
  outputIsUntrusted?: boolean;
}
```

### Members {#tool-members}

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Unique identifier exposed to the LLM. Conventionally snake_case (`read_file`, `web_search`). |
| `description` | `string` | One-paragraph natural-language description the LLM reads to decide when to call this tool. |
| `schema` | `Record<string, unknown>` | JSON Schema for the `args` object. The LLM sees this and constructs calls against it. |
| `toolset` | `string \| undefined` | Group label (`file`, `web`, `terminal`, ...). Used by `ToolRegistry.getForToolset` and some UI filters. |
| `maxResultChars` | `number \| undefined` | Per-call output cap. Combined with the turn-wide budget — see [tool-result-budget](../explanation/tool-result-budget.md). |
| `execute` | `(args, ctx) => Promise<ToolResult>` | Body. Must return a `ToolResult`; thrown errors become `code: 'execution_failed'`. |
| `isAvailable` | `() => boolean` | Optional gate. Called every time the tool list is built — return `false` to hide when a dependency (API key, binary) is missing. |
| `alwaysInclude` | `boolean` | When true, the tool ignores `personality.toolset` filtering. Reserve for framework-internal tools (e.g. `get_skill`). |
| `outputIsUntrusted` | `boolean` | When true, `AgentLoop` sanitises chat-template tokens in the success output and wraps it in `<untrusted source="..." tool="...">…</untrusted>`. Set on every tool that returns adversary-controlled content (file contents, web pages, email bodies, subprocess stdout). |

### Notes {#tool-notes}

- `TArgs` is the runtime type of the parsed `args`. The framework does not validate against `schema` — pair the type with a Zod / Valibot parser inside `execute` if you need strict checking.
- `maxResultChars` is a ceiling, not a target. The actual per-call budget is `Math.min(perCallBudget, maxResultChars ?? perCallBudget)` where `perCallBudget = ctx.resultBudgetChars`.
- A tool whose `name` starts with `mcp__<server>__` is treated as an MCP-server tool and gated by `personality.mcp_servers` rather than `personality.toolset`.

## ToolResult {#tool-result}

### Signature {#tool-result-signature}

```ts
import type { ToolResult } from '@ethosagent/types';

export type ToolResult =
  | { ok: true; value: string; cost_usd?: number }
  | { ok: false; error: string; code: 'input_invalid' | 'not_available' | 'execution_failed' };
```

### Members {#tool-result-members}

| Field | Variant | Description |
|---|---|---|
| `ok` | both | Discriminant. `true` on success, `false` on error. |
| `value` | success | Tool output as a single UTF-8 string. Post-trimmed against the per-call budget. |
| `cost_usd` | success | Optional dollar cost attributed to this call (paid APIs, sandbox time). Surfaced in usage telemetry. |
| `error` | error | Human-readable error message. Goes back to the LLM verbatim. |
| `code` | error | Stable error class. `input_invalid` (LLM produced bad args), `not_available` (tool gated off), `execution_failed` (runtime failure). |

### Notes {#tool-result-notes}

- A tool that throws is automatically converted into `{ ok: false, code: 'execution_failed', error: err.message }` by `ToolRegistry.executeParallel`.
- Always return a `ToolResult` even on partial success — encode the partial result in `value` and explain what worked. The LLM cannot recover from a thrown exception.
- The `[truncated — N chars total]` marker appended by the registry is part of `value`. Test fixtures should expect it.

## ToolContext {#tool-context}

### Signature {#tool-context-signature}

```ts
import type { ToolContext, ToolProgressEvent } from '@ethosagent/types';

export interface ToolContext {
  sessionId: string;
  sessionKey: string;
  platform: string;
  workingDir: string;
  agentId?: string;
  personalityId?: string;
  memoryScope?: 'global' | 'per-personality';
  currentTurn: number;
  messageCount: number;
  abortSignal: AbortSignal;
  emit: (event: ToolProgressEvent) => void;
  resultBudgetChars: number;
  storage?: import('@ethosagent/types').Storage;
  networkPolicy?: {
    allow?: string[];
    deny?: string[];
    allow_private_urls?: boolean;
  };
}
```

### Members {#tool-context-members}

| Field | Type | Description |
|---|---|---|
| `sessionId` | `string` | Stable id of the current [session](../../getting-started/glossary.md#session). |
| `sessionKey` | `string` | Human-meaningful session key (e.g. `cli:my-repo`). |
| `platform` | `string` | Surface the turn is running on (`cli`, `telegram`, `discord`, ...). |
| `workingDir` | `string` | Process cwd at turn start. Anchor relative paths against this. |
| `agentId` | `string \| undefined` | Stable agent identity (multi-agent / [mesh](../../getting-started/glossary.md#mesh) deployments). |
| `personalityId` | `string \| undefined` | Active [personality](../../getting-started/glossary.md#personality). Thread through to memory and storage. |
| `memoryScope` | `'global' \| 'per-personality' \| undefined` | Resolved [memory scope](../../getting-started/glossary.md#memory-scope) for this turn. |
| `currentTurn` | `number` | 1-indexed [turn](../../getting-started/glossary.md#turn) counter for the session. |
| `messageCount` | `number` | Total messages in the session so far. |
| `abortSignal` | `AbortSignal` | Fires when the user cancels or the turn times out. Wire into `fetch`, child processes, anywhere blocking. |
| `emit` | `(ev: ToolProgressEvent) => void` | Emits a [`tool_progress`](./agent-event.md#tool-progress) event. `audience: 'user'` opts the event into user-facing streams. |
| `resultBudgetChars` | `number` | Maximum characters the success `value` may contain before truncation. |
| `storage` | `Storage \| undefined` | Per-turn [`Storage`](./storage-interface.md) decorated with the personality's fs_reach allowlist. Tools that touch `~/.ethos/` MUST use this rather than `node:fs`. |
| `networkPolicy` | object \| undefined | Per-personality network reach. URL-capable tools must thread this through `safeFetch` from `@ethosagent/safety-network`. |

### Notes {#tool-context-notes}

- `emit` defaults events to `audience: 'internal'` if the tool omits the field. Opt into `'user'` only when silent latency would confuse the user.
- `storage` is undefined in some test wirings — tools that need filesystem access should fall back gracefully (e.g. read-only) rather than crash.
- The same `abortSignal` is passed to the LLM call. Once aborted, expect `abortSignal.aborted === true` for the rest of the turn.

## Used by {#used-by}

| Consumer | Role |
|---|---|
| `extensions/tools-file/src/` | `read_file`, `write_file`, `patch_file`, `search_files`. |
| `extensions/tools-terminal/src/` | `terminal` (bash subprocess). |
| `extensions/tools-web/src/` | `web_search`, `fetch_url`. |
| `extensions/tools-browser/src/` | Playwright-driven `browser_*` tools. |
| `extensions/tools-code/src/` | `lint`, `typecheck`, `run_tests`. |
| `extensions/tools-memory/src/` | `update_memory`, `recall_memory`. |
| `extensions/tools-todo/src/` | TODO list CRUD. |
| `extensions/tools-mcp/src/` | Bridges MCP-server tools into the registry. |
| `extensions/tools-delegation/src/` | `task` — spawns subagents. |
| `packages/core/src/tool-registry.ts` | `DefaultToolRegistry.executeParallel` invokes `execute` for every `Tool`. |
| `packages/plugin-sdk/src/tool-helpers.ts` | `defineTool<TArgs>` factory + `ok` / `err` `ToolResult` shorthands. |

## See also {#see-also}

- [ToolRegistry reference](./tool-registry.md) — how tools are registered, filtered, and invoked in parallel.
- [Tool-result budget](../explanation/tool-result-budget.md) — how `maxResultChars` and `resultBudgetChars` combine.
- [Audience boundary](../explanation/audience-boundary.md) — when to use `emit({ audience: 'user' })`.
- [Plugin SDK reference](./plugin-sdk.md) — `defineTool`, `ok`, `err` helpers.
- [Tutorial: write your first tool](../tutorials/write-your-first-tool.md) — apply this interface end-to-end against a `get_weather` example.
