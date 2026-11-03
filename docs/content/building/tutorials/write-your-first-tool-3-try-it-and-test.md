---
title: "Write your first tool, part 3: try it and add unit tests"
description: "Run the tool with Try it, then add unit tests."
kind: tutorial
audience: developer
updated: 2026-11-03
---

## Goal

Finish steps 7-8 of [Write your first tool](write-your-first-tool.md): Try it; Add unit tests.

## Prereqs

- Complete [part 2 of 4](write-your-first-tool-2-write-install-wire.md).

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

## What you learned

- Steps 7-8 done: Try it; Add unit tests.

## Next step

Continue with [part 4 of 4: progress events and choosing a shape](write-your-first-tool-4-progress-and-shape.md).
