---
title: "Tool interface: Tool, ToolResult and ToolProgressEvent"
description: "Tool, ToolResult and ToolProgressEvent interfaces."
kind: reference
audience: developer
updated: 2026-11-03
---

## Synopsis {#synopsis}

The tool shape and what a tool returns or emits. Part of the [Tool interface reference](../tool-interface.md).

## ToolResult {#tool-result}

### Signature {#tool-result-signature}

```ts
import type { ToolResult } from '@ethosagent/types';

export type ToolResult =
  | {
      ok: true;
      value: string;
      structured?: Record<string, unknown>;
      cost_usd?: number;
    }
  | {
      ok: false;
      error: string;
      code: 'input_invalid' | 'not_available' | 'execution_failed' | 'STALE_WRITE';
    };
```

### Success variant {#tool-result-success}

| Field | Type | Description |
|---|---|---|
| `ok` | `true` | Discriminant. |
| `value` | `string` | Human/LLM-readable string. Always present. Post-trimmed against the per-call budget. Multimodal or structured-data tools use this as a concise text summary so the LLM can react without parsing JSON. |
| `structured` | `Record<string, unknown> \| undefined` | Optional structured payload for non-string results (image bytes as base64, tabular data, JSON documents, multi-part content). Consumers that do not know a tool's specific structured shape should ignore this field; `value` carries the authoritative summary. |
| `cost_usd` | `number \| undefined` | Dollar cost attributed to this call (paid APIs, sandbox time). Surfaced in usage telemetry. |

### Error variant {#tool-result-error}

| Field | Type | Description |
|---|---|---|
| `ok` | `false` | Discriminant. |
| `error` | `string` | Human-readable error message. Goes back to the LLM verbatim. |
| `code` | error code | Stable error class (see table below). |

### Error codes {#tool-result-error-codes}

| Code | Meaning |
|---|---|
| `input_invalid` | The LLM produced args that fail validation. |
| `not_available` | The tool is gated off (missing API key, binary, or personality allowlist). |
| `execution_failed` | Runtime failure inside `execute`. |
| `STALE_WRITE` | The file's on-disk mtime differs from the value recorded at read time; the write is refused to prevent silent clobber. |

### Notes {#tool-result-notes}

- A tool that throws is automatically converted into `{ ok: false, code: 'execution_failed', error: err.message }` by `ToolRegistry.executeParallel`.
- Always return a `ToolResult` even on partial success -- encode the partial result in `value` and explain what worked. The LLM cannot recover from a thrown exception.
- The `[truncated -- N chars total]` marker appended by the registry is part of `value`. Test fixtures should expect it.

## ToolProgressEvent {#tool-progress-event}

### Signature {#tool-progress-event-signature}

```ts
import type { ToolProgressEvent } from '@ethosagent/types';

export interface ToolProgressEvent {
  type: 'progress';
  toolName: string;
  message: string;
  percent?: number;
  audience?: 'internal' | 'user' | 'dashboard';
}
```

### Members {#tool-progress-event-members}

| Field | Type | Description |
|---|---|---|
| `type` | `'progress'` | Literal discriminant. |
| `toolName` | `string` | Name of the tool emitting the event. |
| `message` | `string` | Human-readable progress description. |
| `percent` | `number \| undefined` | Optional 0--100 completion percentage. |
| `audience` | `'internal' \| 'user' \| 'dashboard'` | Controls who sees the event. `'internal'` (default when absent): framework only (logs, telemetry, dev TUI). `'user'`: surfaced in the user-visible stream. `'dashboard'`: surfaced on operator dashboards but not to end users. See [audience boundary](../../explanation/audience-boundary.md). |

### Notes {#tool-progress-event-notes}

- Channel adapters (telegram, discord, slack, whatsapp, email) and `apps/ethos/src/commands/chat.ts` must not surface `'internal'` events.
- Use `'user'` sparingly: long-running operations where silent latency would confuse the user (`read_file` reading >1 MB, multi-step `bash` commands).
- The framework never opts in for the tool -- `audience` is always a per-event decision by the tool author.

## Tool&lt;TArgs&gt; {#tool}

### Signature {#tool-signature}

```ts
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';

export interface Tool<TArgs = unknown> {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  toolset?: string;
  maxResultChars?: number;
  capabilities: import('@ethosagent/types').ToolCapabilities;
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
| `toolset` | `string \| undefined` | Group label (`file`, `web`, `terminal`, ...). Used by `ToolRegistry.getForToolset` and personality toolset filtering. |
| `maxResultChars` | `number \| undefined` | Per-call output cap. Combined with the turn-wide budget: `Math.min(perCallBudget, maxResultChars ?? perCallBudget)`. See [tool-result-budget](../../explanation/tool-result-budget.md). |
| `capabilities` | `ToolCapabilities` | Declares which scoped capabilities the tool requires (fs, network, process, secrets, kv). See [tool-capabilities](../tool-capabilities.md). |
| `execute` | `(args: TArgs, ctx: ToolContext) => Promise<ToolResult>` | Body. Must return a `ToolResult`; thrown errors become `code: 'execution_failed'`. |
| `isAvailable` | `() => boolean \| undefined` | Optional gate. Called every time the tool list is built -- return `false` to hide when a dependency (API key, binary) is missing. |
| `alwaysInclude` | `boolean \| undefined` | When true, the tool ignores `personality.toolset` filtering. Reserve for framework-internal tools (e.g. `get_skill`). |
| `outputIsUntrusted` | `boolean \| undefined` | When true, `AgentLoop` sanitises chat-template tokens in the success output and wraps it in `<untrusted source="..." tool="...">...</untrusted>`. Set on every tool that returns adversary-controlled content (file contents, web pages, email bodies, subprocess stdout). |

### Notes {#tool-notes}

- `TArgs` is the runtime type of the parsed `args`. The framework does not validate against `schema` -- pair the type with a Zod / Valibot parser inside `execute` if you need strict checking.
- A tool whose `name` starts with `mcp__<server>__` is treated as an MCP-server tool and gated by `personality.mcp_servers` rather than `personality.toolset`.

## See also {#see-also}

- [Tool interface reference](../tool-interface.md): the index of every section and its page.
