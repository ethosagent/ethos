---
title: "Add an LLM provider"
description: "Build an echo provider implementing LLMProvider — map a streaming source to the CompletionChunk union, ship as extensions/llm-echo."
kind: tutorial
audience: developer
slug: add-an-llm-provider
time: "30 min"
updated: 2026-11-03
---

`LLMProvider` is the seam between Ethos and any model API. The [AgentLoop](../../getting-started/glossary.md#agent-loop) does not know what provider it is talking to — it consumes `AsyncIterable<CompletionChunk>` from `provider.complete()` and yields `AgentEvent` to whatever surface is listening. Your job, as a provider author, is to map your upstream API's streaming events to the `CompletionChunk` variants it has a source for. The union has nine; the echo provider below uses a subset.

This tutorial builds an "echo" provider as the smallest possible exercise of every variant. The provider does not talk to a remote API; it echoes the last user message back, character by character, while emitting realistic `text_delta`, `tool_use_*`, `usage`, and `done` chunks. Once it works, swap the echo body for a real client and the rest of the file stays.

You ship it as `extensions/llm-echo/` inside the monorepo, wired via `config.provider: echo` and a one-line addition to `packages/wiring/src/index.ts`.

## Goal

By the end, you have:

- `extensions/llm-echo/` — a workspace package implementing `LLMProvider` from `@ethosagent/types`.
- An async generator that maps a local stream to `CompletionChunk` variants, including a tool-call delta.
- A path alias and a wiring branch so `config.provider: echo` selects your provider.
- Unit tests that consume the async iterable and assert on the chunks emitted.
- `pnpm dev` running with the echo provider — the agent "responds" by echoing the user message back, every event arrives through the same `AgentLoop` pipeline as a real model.

The echo provider is the lab. Once you can map a local stream to `CompletionChunk`, you can map any real provider — the shape of the work does not change.

## Prereqs

- [Build on Ethos in ten minutes](../quickstart.md) finished — the monorepo cloned, `pnpm check` green, `pnpm dev` runs a chat against your tree.
- Familiarity with `async function*` generators and `for await ... of` loops. The contract is pure async iteration; no event emitters, no callbacks.
- A read of `packages/types/src/llm.ts` (90 lines). Every interface in this tutorial is declared there.
- Optional: skim `extensions/llm-anthropic/src/index.ts` and `extensions/llm-openai-compat/src/index.ts`. The two production providers cover the two interesting cases — content-block streaming and index-keyed tool calls.

## Parts

| Part | Covers |
|---|---|
| 1. Add an LLM provider (this page) | Steps 1-2: Read the contract, Create the extension package |
| [2. Implement the provider](add-an-llm-provider-2-implement-the-provider.md) | Step 3: Implement the provider |
| [3. Wire, run and exercise tool calls](add-an-llm-provider-3-wire-and-run.md) | Steps 4-8: Add the path alias, Wire it into the provider factory, Switch your config to the echo provider, Run it, Exercise the tool-call path |
| [4. Write tests, map a real provider](add-an-llm-provider-4-tests-and-real-providers.md) | Steps 9-10: Write tests, Notes on mapping a real provider |

## 1. Read the contract

`packages/types/src/llm.ts` is the source of truth. The interfaces in order of how often you touch them:

```typescript
export type CompletionChunk =
  | { type: 'text_delta';     text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_use_start'; toolCallId: string; toolName: string }
  | { type: 'tool_use_delta'; toolCallId: string; partialJson: string }
  | { type: 'tool_use_end';   toolCallId: string; inputJson: string }
  | { type: 'usage';          usage: TokenUsage }
  | { type: 'done';           finishReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' }
  | { type: 'warning';        message: string }
  | { type: 'compaction';     content: string | null; encryptedContent: string | null };

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsCaching: boolean;
  readonly supportsThinking: boolean;
  complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk>;
  countTokens(messages: Message[]): Promise<number>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
}
```

A few rules implicit in the contract:

- **One `tool_use_start`, then deltas, then exactly one `tool_use_end` per tool call.** The `inputJson` on the end event is the complete arguments JSON — the AgentLoop parses it once, not the running concatenation of deltas. Emit `tool_use_delta` for streaming-UI surfaces; the loop tolerates zero deltas, only `start` + `end` is required.
- **`usage` must come before `done`.** The loop checks for `usage` to populate the `AgentEvent` of the same name and budget-cap accounting. A provider that never emits `usage` ends the [turn](../../getting-started/glossary.md#turn) with zero recorded cost.
- **Always emit exactly one `done`.** It carries the `finishReason`. The loop branches on `'tool_use'` (run the requested tools and loop back) vs `'end_turn'` (the turn is finished). Without `done`, the surface waits forever for the next chunk.
- **Respect `options.abortSignal`.** Upstream cancellation, `/stop`, and turn timeouts all flow through this signal. Pass it into your network client and the loop closes cleanly.
- **`countTokens` is best-effort.** Anthropic publishes a count endpoint; OpenAI does not, and the compat provider approximates `chars / 4`. The loop uses the count for compaction triggering — a bad number degrades compaction quality, it does not break correctness.

The full reference is at [LLM provider interface](../reference/llm-provider-interface.md).

## 2. Create the extension package

Pick a name; the convention is `extensions/llm-<provider>/`. We are building `llm-echo`:

```bash
mkdir -p extensions/llm-echo/src/__tests__
cd extensions/llm-echo
```

Write `package.json`:

```json
{
  "name": "@ethosagent/llm-echo",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": {
      "import": "./src/index.ts",
      "production": "./dist/index.js"
    }
  },
  "dependencies": {
    "@ethosagent/types": "workspace:*"
  }
}
```

Two conventions to notice:

- **`exports` points at `./src/index.ts`.** Node 24 + tsx resolves the source directly in dev — no build step. The `production` condition points at `./dist/` for the published artefact (`tsup` builds it for release; you do not need it locally).
- **`@ethosagent/types: workspace:*`.** Provider packages depend on `@ethosagent/types` and nothing else from the framework. The interface contract is the only thing you implement against.

Run install from the repo root so pnpm picks up the new workspace member:

```bash
cd ../../
pnpm install
```

## What you learned

- Steps 1-2 done: Read the contract; Create the extension package.

## Next step

Continue with [part 2 of 4: implement the provider](add-an-llm-provider-2-implement-the-provider.md).
