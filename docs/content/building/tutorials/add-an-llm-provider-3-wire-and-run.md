---
title: "Add an LLM provider, part 3: wire, run and exercise tool calls"
description: "Add the path alias, wire the factory, switch config, run, exercise tool calls."
kind: tutorial
audience: developer
updated: 2026-11-03
---

## Goal

Finish steps 4-8 of [Add an LLM provider](add-an-llm-provider.md): Add the path alias; Wire it into the provider factory; Switch your config to the echo provider; Run it; Exercise the tool-call path.

## Prereqs

- Complete [part 2 of 4](add-an-llm-provider-2-implement-the-provider.md).

## 4. Add the path alias

Open the root `tsconfig.json` (or `tsconfig.base.json` — check `extends` in the root) and add the new package to `compilerOptions.paths`:

```json
{
  "compilerOptions": {
    "paths": {
      "@ethosagent/llm-anthropic": ["./extensions/llm-anthropic/src"],
      "@ethosagent/llm-openai-compat": ["./extensions/llm-openai-compat/src"],
      "@ethosagent/llm-echo": ["./extensions/llm-echo/src"]
    }
  }
}
```

Without this alias, `import { EchoProvider } from '@ethosagent/llm-echo'` resolves to `node_modules` (where the package does not exist) and `pnpm typecheck` fails. With it, every workspace package can import the new provider against source.

## 5. Wire it into the provider factory

Provider selection lives in `packages/wiring/src/index.ts` inside `createSingleProvider`. The current shape:

```typescript
function createSingleProvider(cfg: {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}): LLMProvider {
  if (cfg.provider === 'anthropic') {
    return new AnthropicProvider({ apiKey: cfg.apiKey, model: cfg.model });
  }
  return new OpenAICompatProvider({
    name: cfg.provider,
    model: cfg.model,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl ?? 'https://openrouter.ai/api/v1',
  });
}
```

Add an `echo` branch before the OpenAI-compat fallback:

```typescript
import { EchoProvider } from '@ethosagent/llm-echo';

function createSingleProvider(cfg: {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}): LLMProvider {
  if (cfg.provider === 'anthropic') {
    return new AnthropicProvider({ apiKey: cfg.apiKey, model: cfg.model });
  }
  if (cfg.provider === 'echo') {
    return new EchoProvider();
  }
  return new OpenAICompatProvider({
    name: cfg.provider,
    model: cfg.model,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl ?? 'https://openrouter.ai/api/v1',
  });
}
```

Two things to notice:

- **The factory ignores `apiKey` and `baseUrl` for echo.** Real providers receive these from `~/.ethos/config.yaml` (`apiKey`) or fall back to a sensible default (`baseUrl`). The factory is the only place those values are dereferenced — your provider's constructor takes whatever shape it needs.
- **You match on `cfg.provider`.** That string is whatever the user wrote under `provider:` in `~/.ethos/config.yaml`. The OpenAI-compat provider uses the same string as the cosmetic `name` for log lines and `/usage` output (`openrouter`, `ollama`, `gemini`); the Anthropic provider hard-codes its own name.

For multi-provider chains (failover), the same factory is called per entry; nothing else changes.

## 6. Switch your config to the echo provider

Open `~/.ethos/config.yaml` and change the provider line:

```yaml
provider: echo
model: echo-v0
apiKey: not-used-for-echo
```

`apiKey` is required by the schema even though the echo provider ignores it — leave any non-empty string here.

## 7. Run it

```bash
pnpm dev
```

The chat opens. Send a message:

```
You > hello there, world.
```

The streamed reply:

```
You said: hello there, world.
```

Every `text_delta` arrived through `AgentLoop` and reached the surface as a `text_delta` `AgentEvent`. The usage chunk landed under `/usage` (run it inside chat) as zero-cost token counts. The `done` event with `finishReason: 'end_turn'` closed the turn cleanly.

Things you should verify:

- `/usage` shows tokens for both input and output. If the counts are zero, the `usage` chunk is not being yielded — check that you yield it before `done`.
- `Ctrl+C` during a slow stream (set `delayMs: 200` in the constructor) cleanly aborts. If the chat hangs, the `abortSignal` is not being honoured — every `await` in `complete` must be cancellable.
- Switching back to `provider: anthropic` works without restarting the dev shell. The provider is constructed per `createAgentLoop` call, not at process start.

## 8. Exercise the tool-call path

The interesting half of the contract — `tool_use_start`, `tool_use_delta`, `tool_use_end` — has not fired yet because the default echo path skips it. Construct the provider with `emitToolCallOnTurn: 2` to force a tool call on the second turn of the session. Edit the wiring branch:

```typescript
if (cfg.provider === 'echo') {
  return new EchoProvider({ emitToolCallOnTurn: 2 });
}
```

Restart `pnpm dev`. First turn produces the echo. On the second turn, send anything:

```
You > make me lunch.
```

The chat surface streams:

```
[tool_start  ] get_weather { city: "Tokyo" }
[tool_end    ] get_weather · ok · 412ms
You said: make me lunch.
```

The provider yielded `tool_use_start` → two `tool_use_delta` chunks → `tool_use_end` with the full `inputJson` → `done.finishReason: 'tool_use'`. The loop:

1. Saw `finishReason: 'tool_use'`.
2. Parsed `inputJson` once into `{ city: "Tokyo" }`.
3. Ran `executeParallel` against the active personality's [tool registry](../../getting-started/glossary.md#tool-registry).
4. Looped back into `provider.complete()` with the tool result appended as a user message.
5. The echo provider's second iteration emitted the text echo.

This is exactly how a real model interleaves text and tool calls. The chunk sequence is identical; only the source of the decisions changes.

## What you learned

- Steps 4-8 done: Add the path alias; Wire it into the provider factory; Switch your config to the echo provider; Run it; Exercise the tool-call path.

## Next step

Continue with [part 4 of 4: write tests, map a real provider](add-an-llm-provider-4-tests-and-real-providers.md).
