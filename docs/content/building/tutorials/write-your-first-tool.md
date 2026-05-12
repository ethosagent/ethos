---
title: "Write your first tool"
description: "Build a get_weather tool against the Tool interface — typed args, ToolResult contract, maxResultChars, isAvailable gating, registry wiring."
kind: tutorial
audience: developer
slug: write-your-first-tool
time: "20 min"
updated: 2026-05-12
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

## 4. Write the tool

Create `src/index.ts`:

```typescript
import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';
import { defineTool, err, ok } from '@ethosagent/plugin-sdk/tool-helpers';
import type { ToolContext, ToolResult } from '@ethosagent/types';

interface GetWeatherArgs {
  city: string;
}

const getWeatherTool = defineTool<GetWeatherArgs>({
  name: 'get_weather',
  description:
    'Return the current weather for a single city. Use when the user asks about temperature, conditions, or whether it is raining somewhere.',
  toolset: 'weather',
  maxResultChars: 1_000,

  isAvailable: () => Boolean(process.env.WEATHER_API_KEY),

  schema: {
    type: 'object',
    properties: {
      city: {
        type: 'string',
        description:
          'City name. Plain text, no country code. Examples: "Tokyo", "San Francisco", "Berlin".',
      },
    },
    required: ['city'],
  },

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const { city } = args;

    // 1. Validate the input.
    if (!city || typeof city !== 'string' || city.trim().length === 0) {
      return err('city must be a non-empty string', 'input_invalid');
    }

    // 2. Check the environment.
    const apiKey = process.env.WEATHER_API_KEY;
    if (!apiKey) {
      return err('WEATHER_API_KEY not set', 'not_available');
    }

    // 3. Call the upstream. Respect the abort signal so /stop and turn-cancel
    //    propagate. Without this, the tool keeps running after the agent
    //    decides to abandon the turn.
    try {
      const url =
        `https://api.weatherapi.com/v1/current.json` +
        `?key=${apiKey}&q=${encodeURIComponent(city.trim())}`;
      const res = await fetch(url, { signal: ctx.abortSignal });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return err(`weather API ${res.status}: ${body.slice(0, 200)}`, 'execution_failed');
      }

      const data = (await res.json()) as {
        location: { name: string; country: string };
        current: { temp_c: number; condition: { text: string } };
      };

      // 4. Format the value as one line of natural prose. The string becomes
      //    the user-turn input for the LLM's next completion; write it for
      //    a reader, not a parser.
      const where = `${data.location.name}, ${data.location.country}`;
      const reading = `${data.current.temp_c}°C and ${data.current.condition.text.toLowerCase()}`;
      return ok(`Current weather in ${where}: ${reading}.`);
    } catch (e) {
      // AbortError is the framework cancelling the turn. Treat it as a
      // benign termination — no error code reads better than a stack trace.
      if (e instanceof Error && e.name === 'AbortError') {
        return err('weather request cancelled', 'execution_failed');
      }
      return err(e instanceof Error ? e.message : String(e), 'execution_failed');
    }
  },
});

export function activate(api: EthosPluginApi): void {
  api.registerTool(getWeatherTool);
}

export function deactivate(): void {}

const plugin: EthosPlugin = { activate, deactivate };
export default plugin;
```

That is the whole file. Walk through it once before moving on:

- **`isAvailable`** is checked at registry-list time. When `WEATHER_API_KEY` is unset, the tool is hidden from the LLM's catalog — the model never sees it and cannot call it. `getAvailable()` in `packages/core/src/tool-registry.ts` is the gate; both `toDefinitions` (what the model sees) and `executeParallel` (what actually runs) respect it.
- **`maxResultChars: 1_000`** caps the per-call output. This tool's output is short by construction, but declaring the cap means runaway upstream responses cannot blow the 80,000-char per-turn budget.
- **`code` discriminates the failure kind.** `input_invalid` for bad arguments — the LLM may retry with corrected arguments. `not_available` for missing config — the LLM should stop trying. `execution_failed` for upstream errors — the LLM may retry once, then give up.
- **`ctx.abortSignal`** is wired into `fetch`. `/stop` in chat, the agent abandoning the turn, and per-turn timeouts all flow through this signal. A tool that ignores it keeps running after the agent has moved on.
- **`activate(api)`** is the plugin entry point. `api.registerTool` tags the tool with this plugin's id so the personality-level plugin allowlist can gate it. `deactivate` is optional — implement it when you have resources (DB connections, file watchers, timers) that need cleanup on `ethos plugin uninstall`.

## 5. Install the plugin

There are two install paths. For local development, point at the directory:

```bash
ethos plugin install ~/code/ethos-plugin-weather
```

`ethos plugin install` validates the package, runs `activate()` in a sandbox to surface load errors, and writes the path into `~/.ethos/config.yaml`:

```yaml
plugins:
  - /Users/you/code/ethos-plugin-weather
```

For published plugins, install from npm and reference by package name:

```bash
npm install -g ethos-plugin-weather
ethos plugin install ethos-plugin-weather
```

Either way, the next `ethos chat` boot will pick up the plugin. Verify:

```bash
ethos plugin list
```

You should see `ethos-plugin-weather` with one tool: `get_weather`.

## 6. Wire the tool into a personality

A registered tool is invisible to the LLM until it lands in the active personality's `toolset.yaml`. The framework's [ToolRegistry](../../getting-started/glossary.md#tool-registry) intersects `registered_tools ∩ personality.toolset` and only the intersection reaches the model.

For built-in personalities (researcher, engineer, reviewer, coach, operator), override the bundled toolset by creating the user-side directory:

```bash
mkdir -p ~/.ethos/personalities/researcher
cp extensions/personalities/data/researcher/toolset.yaml ~/.ethos/personalities/researcher/
echo "- get_weather" >> ~/.ethos/personalities/researcher/toolset.yaml
```

The user file takes precedence. The personality registry is mtime-cached on three files per directory; the next [turn](../../getting-started/glossary.md#turn) sees the updated catalog without a restart — see [Create your first personality](../../using/tutorials/first-personality.md) for the full hot-reload model.

You also need to attach the plugin to this personality. Plugin-registered tools are default-deny per personality (the [Storage scope](../../getting-started/glossary.md#storage-scope) and plugin allowlist are the gates — the same model as MCP servers):

```bash
ethos personality plugins researcher --attach ethos-plugin-weather
```

Confirm:

```bash
ethos personality plugins researcher
```

You should see `[✓] ethos-plugin-weather`.

## 7. Try it

Start chat:

```bash
ANTHROPIC_API_KEY=... WEATHER_API_KEY=... ethos chat
```

Send:

```
You > what is the weather in Tokyo right now?
```

The streamed output:

```
[tool_start  ] get_weather { city: "Tokyo" }
[tool_end    ] get_weather · ok · 412ms

It is 18°C and partly cloudy in Tokyo right now.
```

The `[tool_start]` line is the `AgentLoop` emitting a `tool_start` event from its `AsyncGenerator<AgentEvent>` stream. `[tool_end]` carries the ok/error flag and the duration. The agent's natural-language reply follows after a second LLM completion that consumed the tool result.

If the tool is not called at all, two things are most likely wrong:

- `WEATHER_API_KEY` is unset in the shell, so `isAvailable()` returns false and the tool never appears in the LLM's catalog. Verify with `/tools` inside chat — `get_weather` should be listed.
- The personality's `toolset.yaml` does not list `get_weather`, or the plugin is not attached. Re-run step 6.

If the tool is called but fails, the failure shape tells you which:

- `input_invalid` — the model passed an empty string. Usually means the description is too vague; sharpen the prose so the model knows what to send.
- `not_available` — `WEATHER_API_KEY` is set in `~/.ethos/config.yaml` but missing from the env that started `ethos chat`. Re-export it.
- `execution_failed` with `weather API 401` — the key is wrong. With `weather API 429` — you hit the free-tier rate limit.

## 8. Add unit tests

Tools are pure(-ish) functions. Test them by calling `execute` directly with a stub `ToolContext`. Create `src/__tests__/get-weather.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@ethosagent/types';
import getWeatherPlugin from '..';

function stubContext(): ToolContext {
  return {
    sessionId: 't',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: process.cwd(),
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  };
}

// Extract the tool from the plugin for direct testing.
let registered: any;
const api = {
  pluginId: 'test',
  registerTool: (t: any) => {
    registered = t;
  },
  // The rest of EthosPluginApi is unused in this test.
} as any;
getWeatherPlugin.activate(api);

const tool = registered as {
  isAvailable: () => boolean;
  execute: (args: { city: string }, ctx: ToolContext) => Promise<any>;
};

describe('get_weather', () => {
  beforeEach(() => {
    process.env.WEATHER_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.WEATHER_API_KEY;
    vi.restoreAllMocks();
  });

  it('hides itself when WEATHER_API_KEY is unset', () => {
    delete process.env.WEATHER_API_KEY;
    expect(tool.isAvailable()).toBe(false);
  });

  it('rejects empty city with input_invalid', async () => {
    const result = await tool.execute({ city: '' }, stubContext());
    expect(result).toMatchObject({ ok: false, code: 'input_invalid' });
  });

  it('returns one-line forecast on a 200 response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          location: { name: 'Tokyo', country: 'Japan' },
          current: { temp_c: 18, condition: { text: 'Partly cloudy' } },
        }),
        { status: 200 },
      ),
    );
    const result = await tool.execute({ city: 'Tokyo' }, stubContext());
    expect(result).toEqual({
      ok: true,
      value: 'Current weather in Tokyo, Japan: 18°C and partly cloudy.',
    });
  });

  it('returns execution_failed on non-200 response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    const result = await tool.execute({ city: 'Tokyo' }, stubContext());
    expect(result).toMatchObject({ ok: false, code: 'execution_failed' });
  });
});
```

Run them:

```bash
pnpm vitest
```

All four pass. The framework is uninvolved — you exercise the tool's contract directly. Real production tests under `extensions/tools-file/src/__tests__/` follow this same pattern; read them when you want examples for more complex tools (filesystem access, abort handling under load, streaming progress events).

## 9. Use progress events for long-running calls

The weather API returns in under a second. For tools that take longer (multi-step shell, large file reads, web crawls), surface progress through `ctx.emit`:

```typescript
async execute(args, ctx) {
  ctx.emit({
    type: 'progress',
    toolName: 'get_weather',
    message: `fetching ${args.city}...`,
    audience: 'user', // explicit opt-in
  });
  const res = await fetch(url, { signal: ctx.abortSignal });
  if (!res.ok) return err(`weather API ${res.status}`, 'execution_failed');
  const data = (await res.json()) as { current: { temp_c: number } };
  return ok(`${args.city}: ${data.current.temp_c}°C`);
}
```

`audience` is the gate on what the user actually sees. The default — `'internal'` — is consumed by the framework only: logs, telemetry, the dev TUI. Channel adapters (Telegram, Discord, Slack) and the CLI's chat surface drop internal-audience events. `audience: 'user'` is a per-event opt-in by the tool author for cases where silent latency would be confusing.

The contract: opt into `'user'` sparingly. Once per multi-second operation, not on every internal step. See [Why an audience boundary on progress?](../explanation/audience-boundary.md) for the rationale.

## 10. Decide between plugin and in-monorepo extension

If you intend the tool to ship as part of Ethos itself — improvements to file tools, new web tools, a kanban tool — the in-monorepo extension path is correct. The shape is identical but the wiring is different:

```
extensions/tools-weather/
├── package.json                 # name "@ethosagent/tools-weather", workspace:* deps
├── src/
│   ├── index.ts                 # export createWeatherTools(): Tool[]
│   └── __tests__/
│       └── weather.test.ts
```

In `packages/wiring/src/index.ts`, inside `createAgentLoop`, add:

```typescript
import { createWeatherTools } from '@ethosagent/tools-weather';
// ... existing imports above ...
for (const tool of createWeatherTools()) tools.register(tool);
```

And add the path alias to root `tsconfig.json`:

```json
{
  "paths": {
    "@ethosagent/tools-weather": ["./extensions/tools-weather/src"]
  }
}
```

That is the entire wiring. The tsx + extensionless-imports convention means no build step is needed — `pnpm dev` picks the tool up on next boot.

The plugin path is right for everything else: your own tool repo, a published npm package, a customer-specific extension that should not live in the framework's main line.

## What you learned

- A tool is an object implementing `Tool<TArgs>` from `@ethosagent/types`: `name`, `description`, JSON `schema`, an `execute` returning a discriminated `ToolResult`, optional `maxResultChars`, `isAvailable`, `toolset`, and `outputIsUntrusted`.
- `execute` never throws — failures are values with one of three `code` strings. Throwing breaks the Anthropic message contract.
- `isAvailable` hides the tool when prerequisites (env vars, services, files) are missing — the LLM never sees it.
- The framework's per-turn budget is 80,000 chars split across concurrent tool calls; `maxResultChars` declares a tighter per-call cap, and outputs over the cap are trimmed with `[truncated — N chars total]`.
- `ctx.abortSignal` flows from `/stop`, turn timeouts, and the loop's own cancellation paths — wire it into every network call.
- A registered tool is invisible until it lands in the active personality's `toolset.yaml`; plugin tools also require the plugin to be attached via `ethos personality plugins <id> --attach <plugin-id>`.
- Tools are unit-testable in isolation — pass a stub `ToolContext` and assert on the `ToolResult` discriminant.

## Next step

You have a tool the agent calls. Next, plug in a new model provider that streams `CompletionChunk` events back into the same `AgentLoop` — the second half of the extension surface.

- [Add an LLM provider](./add-an-llm-provider.md) — build an echo provider implementing `LLMProvider`.
- [Add a channel adapter](./add-a-channel-adapter.md) — bridge a new messaging platform into the gateway.
- [Tool interface reference](../reference/tool-interface.md) — every field on `Tool<TArgs>`, `ToolContext`, and `ToolResult`.
- [Publish a plugin](../how-to/publish-a-plugin.md) — package and publish the plugin to npm so other people can install it.
