---
title: "Write your first tool"
description: "Build a get_weather tool against the Tool interface — typed args, ToolResult contract, maxResultChars, isAvailable gating, registry wiring."
kind: tutorial
audience: developer
slug: write-your-first-tool
time: "20 min"
updated: 2026-11-03
---

The shortest path from the `Tool<TArgs>` interface to a working tool the agent calls during a [turn](../../getting-started/glossary.md#turn). This tutorial builds `get_weather` — a tool that takes a city, returns a one-line forecast, and demonstrates every part of the production contract: typed args, `ToolResult` codes, `maxResultChars`, `isAvailable`, abort handling, and registry wiring.

You ship it two ways: as an in-monorepo extension (the path the bundled tools follow) and as a stand-alone plugin (the path third-party authors take). By the end you can pick the right shape for any tool you want to write next.

## Goal

By the end, you have:

- A `get_weather` [tool](../../getting-started/glossary.md#tool) implementing `Tool<{ city: string }>` from `@ethosagent/types`.
- The tool registered through the `DefaultToolRegistry` and visible in your active [personality's](../../getting-started/glossary.md#personality) `toolset.yaml`.
- An `isAvailable` gate that hides the tool when `WEATHER_API_KEY` is unset.
- A `maxResultChars` cap so the tool plays nicely with the framework's per-turn budget.
- Unit tests that exercise `execute` directly with a stub `ToolContext`.
- A working chat invocation: "what is the weather in Tokyo?" → the agent calls `get_weather` → you see the streamed `tool_start` / `tool_end` events and the natural-language reply.

## Prereqs

- [Build on Ethos in ten minutes](../quickstart.md) finished — you have the monorepo cloned, `pnpm check` green, and `pnpm dev` running a chat against your local tree.
- A working `~/.ethos/config.yaml` from `pnpm dev`'s first-run setup, pointing at an LLM provider you can actually reach.
- One free-tier weather API key. The examples use [api.weatherapi.com](https://www.weatherapi.com); any provider that returns JSON works — swap the URL and the field names.
- Familiarity with TypeScript discriminated unions. `ToolResult` is one — you will pattern-match on `ok` rather than throw.

## Parts

| Part | Covers |
|---|---|
| 1. Write your first tool (this page) | Steps 1-3: Read the contract before you write any code, Pick the shape: in-monorepo extension or stand-alone plugin, Create the plugin package |
| <a id="5-install-the-plugin"></a>[2. Write, install and wire the tool](write-your-first-tool-2-write-install-wire.md) | Steps 4-6: Write the tool, Install the plugin, Wire the tool into a personality |
| [3. Try it and add unit tests](write-your-first-tool-3-try-it-and-test.md) | Steps 7-8: Try it, Add unit tests |
| [4. Progress events and choosing a shape](write-your-first-tool-4-progress-and-shape.md) | Steps 9-10: Use progress events for long-running calls, Decide between plugin and in-monorepo extension |

## 1. Read the contract before you write any code

Open `packages/types/src/tool.ts` and read it end to end. It is 130 lines, fully commented, and the interfaces you are about to implement live there verbatim. The two that matter most:

```typescript
export type ToolResult =
  | { ok: true; value: string; cost_usd?: number }
  | { ok: false; error: string; code: 'input_invalid' | 'not_available' | 'execution_failed' };

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

A few rules that fall out of the contract:

- `execute` never throws. Errors are values: return `{ ok: false, error, code }` and the framework persists a `tool_result` block with `is_error: true` so the LLM history stays valid. Throwing leaks an exception into `AgentLoop` and breaks the Anthropic message contract (every `tool_use` needs a matching `tool_result`).
- `schema` is JSON Schema. Whatever you write here is exactly what the LLM sees. Strict types, real descriptions, real `required` lists. The model uses this to decide whether to call your tool and what arguments to pass.
- `value` is a string. Not a structured object. The string becomes the next user-turn content for the LLM. Format it for the reader, not for a parser.
- `maxResultChars` caps the per-call budget. The framework's default per-turn budget is 80,000 chars split across concurrent tool calls; a tool can declare a tighter cap (`read_file` uses 20,000, `web_search` uses 15,000). Output exceeding the cap is trimmed with a `[truncated — N chars total]` marker.

The full interface, including `ToolContext` and the `audience` field on progress events, is in the [Tool interface reference](../reference/tool-interface.md).

## 2. Pick the shape: in-monorepo extension or stand-alone plugin

There are two shapes for shipping a tool. Pick by who owns it:

| Shape | Lives at | Wired by | Use when |
|---|---|---|---|
| In-monorepo extension | `extensions/tools-<name>/` | `packages/wiring/src/index.ts` | The tool ships with Ethos, every personality can include it, you can vendor changes. |
| Stand-alone plugin | npm package implementing `EthosPlugin` | `~/.ethos/config.yaml` `plugins:` list | The tool is yours, deployed independently, installable by anyone without forking. |

This tutorial walks the plugin path because it is the one most readers want — your code lives in your own repository, not the framework's. The in-monorepo path is identical except the wiring step happens inside `createAgentLoop` instead of `activate(api)`.

## 3. Create the plugin package

A plugin is a normal npm package that default-exports an `EthosPlugin` from `@ethosagent/plugin-sdk`. Create the directory anywhere on your filesystem:

```bash
mkdir -p ~/code/ethos-plugin-weather/src
cd ~/code/ethos-plugin-weather
```

Write `package.json`:

```json
{
  "name": "ethos-plugin-weather",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@ethosagent/plugin-sdk": "*",
    "@ethosagent/types": "*"
  }
}
```

Install:

```bash
pnpm install
```

`@ethosagent/plugin-sdk` re-exports the `Tool` / `ToolResult` / `ToolContext` types from `@ethosagent/types`, plus two tiny helpers (`ok`, `err`) and a `defineTool` factory that improves type inference when you pin `TArgs`. You can write the tool with raw `Tool<TArgs>` from `@ethosagent/types` if you prefer — the helpers are convenience, not contract.

## What you learned

- Steps 1-3 done: Read the contract before you write any code; Pick the shape: in-monorepo extension or stand-alone plugin; Create the plugin package.

## Next step

Continue with [part 2 of 4: write, install and wire the tool](write-your-first-tool-2-write-install-wire.md).
