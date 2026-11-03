---
title: "Write your first tool, part 4: progress events and choosing a shape"
description: "Use progress events for long calls and choose plugin or extension."
kind: tutorial
audience: developer
updated: 2026-11-03
---

## Goal

Finish steps 9-10 of [Write your first tool](write-your-first-tool.md): Use progress events for long-running calls; Decide between plugin and in-monorepo extension.

## Prereqs

- Complete [part 3 of 4](write-your-first-tool-3-try-it-and-test.md).

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
