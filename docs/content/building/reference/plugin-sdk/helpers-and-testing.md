---
title: "Plugin SDK: defineTool, ok and err, and test utilities"
description: "defineTool, ok/err helpers and plugin SDK test utilities."
kind: reference
audience: developer
updated: 2026-11-03
---

## Synopsis {#synopsis}

Helpers for writing and testing plugin tools. Part of the [Plugin SDK reference](../plugin-sdk.md).

## defineTool {#define-tool}

Type-safe `Tool<TArgs>` factory.

### Signature {#define-tool-signature}

```ts
import { defineTool } from '@ethosagent/plugin-sdk';

export function defineTool<TArgs = unknown>(def: ToolDefinition<TArgs>): Tool<TArgs>;

export interface ToolDefinition<TArgs = unknown> {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  toolset?: string;
  maxResultChars?: number;
  isAvailable?: () => boolean;
  execute: (args: TArgs, ctx: ToolContext) => Promise<ToolResult>;
}
```

### Notes {#define-tool-notes}

- Identical to writing a `Tool` literal — pure types, no runtime wrapping.
- The generic `TArgs` flows into `execute(args, ctx)` so `args` is typed inside the function body.
- See the [Tool interface reference](../tool-interface.md#tool) for the full set of `Tool` fields (`outputIsUntrusted`, `alwaysInclude`); `ToolDefinition` exposes the subset plugins normally need.

## ok / err {#ok-err}

`ToolResult` shorthands.

### Signature {#ok-err-signature}

```ts
import { ok, err } from '@ethosagent/plugin-sdk';

export function ok(value: string): ToolResult;
export function err(
  error: string,
  code?: 'input_invalid' | 'not_available' | 'execution_failed',
): ToolResult;
```

`err`'s `code` defaults to `'execution_failed'`. Pass `'input_invalid'` when the LLM provided bad args, `'not_available'` when a dependency is missing.

## Test utilities {#test-utilities}

Importable from `@ethosagent/plugin-sdk/testing`.

### mockLLM {#mock-llm}

```ts
import { mockLLM } from '@ethosagent/plugin-sdk/testing';

const llm = mockLLM(['Hello!', 'Goodbye.']);
```

Returns an `LLMProvider` that streams the given strings in order, one `text_delta` chunk + one `done` chunk per response. `callCount` cycles modulo the array length.

### mockTool {#mock-tool}

```ts
import { mockTool } from '@ethosagent/plugin-sdk/testing';

const t1 = mockTool('greeter', 'Hello, world!');
const t2 = mockTool('fail', { ok: false, error: 'boom', code: 'execution_failed' });
```

Creates a `Tool` whose `execute` always returns the given `ToolResult`. Pass a string as shorthand for `{ ok: true, value: string }`.

### createTestRuntime {#create-test-runtime}

```ts
import { createTestRuntime, mockLLM } from '@ethosagent/plugin-sdk/testing';

const loop = createTestRuntime({ llm: mockLLM(['Hello!']) });
for await (const event of loop.run('hi')) {
  if (event.type === 'done') console.log(event.text);
}
```

Constructs a minimal `AgentLoop` for plugin tests. `tools` defaults to a fresh `DefaultToolRegistry`, `hooks` to a fresh `DefaultHookRegistry`; everything else passes through to `AgentLoopConfig`.

## See also {#see-also}

- [Plugin SDK reference](../plugin-sdk.md): the index of every section and its page.
