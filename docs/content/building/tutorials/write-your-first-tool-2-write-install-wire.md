---
title: "Write your first tool, part 2: write, install and wire the tool"
description: "Write the tool, install the plugin and wire it into a personality."
kind: tutorial
audience: developer
updated: 2026-11-03
---

## Goal

Finish steps 4-6 of [Write your first tool](write-your-first-tool.md): Write the tool; Install the plugin; Wire the tool into a personality.

## Prereqs

- Complete [part 1 of 4](write-your-first-tool.md).

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

For built-in personalities (researcher, engineer, reviewer), override the bundled toolset by creating the user-side directory:

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

## What you learned

- Steps 4-6 done: Write the tool; Install the plugin; Wire the tool into a personality.

## Next step

Continue with [part 3 of 4: try it and add unit tests](write-your-first-tool-3-try-it-and-test.md).
