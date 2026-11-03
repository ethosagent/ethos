---
title: "Tool interface: ToolResultReducer and its registry"
description: "ToolResultReducer and its registry interfaces."
kind: reference
audience: developer
updated: 2026-11-03
---

## Synopsis {#synopsis}

The pipeline that trims tool output before it enters the context window. Part of the [Tool interface reference](../tool-interface.md).

## ToolReducerContext {#tool-reducer-context}

### Signature {#tool-reducer-context-signature}

```ts
import type { ToolReducerContext } from '@ethosagent/types';

export interface ToolReducerContext {
  args: unknown;
  turnCount: number;
}
```

### Members {#tool-reducer-context-members}

| Field | Type | Description |
|---|---|---|
| `args` | `unknown` | The original args passed to the tool's `execute` call. Useful for reducers that need to know what was requested (e.g. a `read_file` reducer that strips differently based on the requested line range). |
| `turnCount` | `number` | Current turn count. Reducers may apply more aggressive trimming on later turns when context pressure is higher. |

## ToolResultReducer {#tool-result-reducer}

### Signature {#tool-result-reducer-signature}

```ts
import type { ToolResultReducer, ToolResult, ToolReducerContext } from '@ethosagent/types';

export interface ToolResultReducer {
  readonly toolName: string;
  reduce(result: ToolResult, ctx: ToolReducerContext): ToolResult;
}
```

### Members {#tool-result-reducer-members}

| Field | Type | Description |
|---|---|---|
| `toolName` | `readonly string` | Name of the tool this reducer applies to. Exact match -- no regex, no wildcards. |
| `reduce` | `(result: ToolResult, ctx: ToolReducerContext) => ToolResult` | Transform a tool result into a signal-only form. Must be deterministic: same input must produce same output. No LLM calls. Must not throw -- return the original result on any internal error. |

### Notes {#tool-result-reducer-notes}

- Reducers run inside `ToolRegistry.executeParallel` after `execute` returns and before the result is placed into the LLM context.
- A reducer that throws violates the contract. Defensive callers wrap the call, but the reducer itself must handle its own errors.
- Reducers must not call LLM APIs. They are a deterministic, synchronous-shaped transform (the signature is sync despite operating on `ToolResult`).

## ToolResultReducerRegistry {#tool-result-reducer-registry}

### Signature {#tool-result-reducer-registry-signature}

```ts
import type { ToolResultReducerRegistry } from '@ethosagent/types';

export interface ToolResultReducerRegistry {
  register(reducer: ToolResultReducer): () => void;
  get(toolName: string): ToolResultReducer | undefined;
}
```

### Members {#tool-result-reducer-registry-members}

| Method | Returns | Description |
|---|---|---|
| `register` | `() => void` | Register a reducer for a specific tool name. Returns a cleanup function that unregisters the reducer. Throws if a reducer for the same `toolName` is already registered -- one reducer per tool. |
| `get` | `ToolResultReducer \| undefined` | Look up the reducer for a tool by name. Returns `undefined` if no reducer is registered. |

### Notes {#tool-result-reducer-registry-notes}

- Duplicate registration throws -- this is intentional. Two reducers for the same tool would produce ambiguous output. If a plugin needs to override a built-in reducer, unregister the existing one first (via the cleanup function) then register the replacement.
- The cleanup function returned by `register` is idempotent -- calling it twice is safe.

## See also {#see-also}

- [Tool interface reference](../tool-interface.md): the index of every section and its page.
