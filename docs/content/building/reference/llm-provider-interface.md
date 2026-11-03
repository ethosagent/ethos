---
title: "LLMProvider interface"
description: "LLMProvider.complete and the nine CompletionChunk variants every Ethos LLM provider streams."
kind: reference
audience: developer
slug: llm-provider-interface
updated: 2026-11-03
---

`LLMProvider` is the contract every Ethos LLM integration implements. `AgentLoop` calls `complete()` once per LLM round-trip and consumes the returned `AsyncIterable<CompletionChunk>` until a `done` chunk arrives.

## Source {#source}

Defined in [`packages/types/src/llm.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/llm.ts). Re-exported from `@ethosagent/types`.

## LLMProvider {#llm-provider}

### Signature {#llm-provider-signature}

```ts
import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ToolDefinitionLite,
} from '@ethosagent/types';

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
```

### Members {#llm-provider-members}

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Stable provider id used in routing and telemetry (`anthropic`, `openai-compat`). |
| `model` | `string` | Default model id. May be overridden per call via `CompletionOptions.modelOverride`. |
| `maxContextTokens` | `number` | Context-window size. Used by `AgentLoop` to decide when to compact. |
| `supportsCaching` | `boolean` | True when the provider honours `CompletionOptions.cacheSystemPrompt`. |
| `supportsThinking` | `boolean` | True when the provider streams `thinking_delta` chunks for extended thinking. |
| `complete` | function | Streams a single completion. See [below](#complete). |
| `countTokens` | `(messages) => Promise<number>` | Tokeniser estimate. Used for context-window accounting before the call. |

### complete {#complete}

```ts
complete(
  messages: Message[],
  tools: ToolDefinitionLite[],
  options: CompletionOptions,
): AsyncIterable<CompletionChunk>
```

| Param | Type | Description |
|---|---|---|
| `messages` | `Message[]` | Full conversation history. Each message has `role: 'user' \| 'assistant'` and `content` which is either a string or an array of typed content blocks (text, tool_use, tool_result). |
| `tools` | `ToolDefinitionLite[]` | Filtered tool list — `{ name, description, parameters }` per tool. `AgentLoop` precomputes this via `ToolRegistry.toDefinitions(allowedTools)`. |
| `options` | `CompletionOptions` | Per-call overrides — see [below](llm-provider-interface/completion-types.md#completion-options). |

Returns an `AsyncIterable<CompletionChunk>`. The iterable terminates after exactly one `done` chunk; consumers must not `break` early without aborting via `options.abortSignal`.

### Notes {#llm-provider-notes}

- Providers must translate provider-specific streaming events into the nine `CompletionChunk` variants. Errors should be surfaced via thrown exceptions, not via an out-of-band chunk type.
- `countTokens` may approximate. The framework uses it for budget planning, not exact cost accounting (that comes from the `usage` chunk).
- `tools` is the filtered list — do not re-filter inside the provider. If the LLM calls a tool not present in `tools`, that is a provider bug.

## Used by {#used-by}

| Consumer | Role |
|---|---|
| `extensions/llm-anthropic/src/index.ts` | `AnthropicProvider` — Claude models via `@anthropic-ai/sdk`. |
| `extensions/llm-anthropic/src/auth-rotating.ts` | `AuthRotatingProvider` — wraps another `LLMProvider` and rotates through auth profiles on failure. |
| `extensions/llm-openai-compat/src/index.ts` | `OpenAICompatProvider` — OpenAI / OpenRouter / Ollama / Gemini. |
| `packages/core/src/agent-loop.ts` | Calls `complete()` and translates `CompletionChunk` events into `AgentEvent`. |
| `packages/plugin-sdk/src/testing.ts` | `mockLLM(responses)` — returns a deterministic provider for plugin tests. |
| `extensions/eval-harness/src/runner.ts` | Eval runner — captures `usage` chunks for cost reporting. |

## Subpages {#subpages}

| Section | Page |
| --- | --- |
| <a id="completion-options"></a>[CompletionOptions](llm-provider-interface/completion-types.md#completion-options) | [LLM provider interface: completion options, chunks, usage and failover](llm-provider-interface/completion-types.md) |
| <a id="completion-options-signature"></a>[Signature](llm-provider-interface/completion-types.md#completion-options-signature) | [LLM provider interface: completion options, chunks, usage and failover](llm-provider-interface/completion-types.md) |
| <a id="completion-options-members"></a>[Members](llm-provider-interface/completion-types.md#completion-options-members) | [LLM provider interface: completion options, chunks, usage and failover](llm-provider-interface/completion-types.md) |
| <a id="completion-chunk"></a>[CompletionChunk](llm-provider-interface/completion-types.md#completion-chunk) | [LLM provider interface: completion options, chunks, usage and failover](llm-provider-interface/completion-types.md) |
| <a id="completion-chunk-signature"></a>[Signature](llm-provider-interface/completion-types.md#completion-chunk-signature) | [LLM provider interface: completion options, chunks, usage and failover](llm-provider-interface/completion-types.md) |
| <a id="completion-chunk-variants"></a>[Variants](llm-provider-interface/completion-types.md#completion-chunk-variants) | [LLM provider interface: completion options, chunks, usage and failover](llm-provider-interface/completion-types.md) |
| <a id="completion-chunk-notes"></a>[Notes](llm-provider-interface/completion-types.md#completion-chunk-notes) | [LLM provider interface: completion options, chunks, usage and failover](llm-provider-interface/completion-types.md) |
| <a id="text-delta"></a>[text_delta](llm-provider-interface/completion-types.md#text-delta) | [LLM provider interface: completion options, chunks, usage and failover](llm-provider-interface/completion-types.md) |
| <a id="thinking-delta"></a>[thinking_delta](llm-provider-interface/completion-types.md#thinking-delta) | [LLM provider interface: completion options, chunks, usage and failover](llm-provider-interface/completion-types.md) |
| <a id="tool-use-start"></a>[tool_use_start](llm-provider-interface/completion-types.md#tool-use-start) | [LLM provider interface: completion options, chunks, usage and failover](llm-provider-interface/completion-types.md) |
| <a id="tool-use-delta"></a>[tool_use_delta](llm-provider-interface/completion-types.md#tool-use-delta) | [LLM provider interface: completion options, chunks, usage and failover](llm-provider-interface/completion-types.md) |
| <a id="tool-use-end"></a>[tool_use_end](llm-provider-interface/completion-types.md#tool-use-end) | [LLM provider interface: completion options, chunks, usage and failover](llm-provider-interface/completion-types.md) |
| <a id="usage"></a>[usage](llm-provider-interface/completion-types.md#usage) | [LLM provider interface: completion options, chunks, usage and failover](llm-provider-interface/completion-types.md) |
| <a id="done"></a>[done](llm-provider-interface/completion-types.md#done) | [LLM provider interface: completion options, chunks, usage and failover](llm-provider-interface/completion-types.md) |
| <a id="warning"></a>[warning](llm-provider-interface/completion-types.md#warning) | [LLM provider interface: completion options, chunks, usage and failover](llm-provider-interface/completion-types.md) |
| <a id="compaction"></a>[compaction](llm-provider-interface/completion-types.md#compaction) | [LLM provider interface: completion options, chunks, usage and failover](llm-provider-interface/completion-types.md) |
| <a id="token-usage"></a>[TokenUsage](llm-provider-interface/completion-types.md#token-usage) | [LLM provider interface: completion options, chunks, usage and failover](llm-provider-interface/completion-types.md) |
| <a id="failover-reason"></a>[FailoverReason](llm-provider-interface/completion-types.md#failover-reason) | [LLM provider interface: completion options, chunks, usage and failover](llm-provider-interface/completion-types.md) |

## See also {#see-also}

- [AgentEvent reference](./agent-event.md) — the surface-facing event stream `AgentLoop` builds from `CompletionChunk`.
- [Tool interface](./tool-interface.md) — `ToolDefinitionLite` mirrors `Tool.schema` for the LLM call.
- [Tutorial: add an LLM provider](../tutorials/add-an-llm-provider.md) — implement this interface end-to-end against a fake `echo` provider.
- [Glossary: Agent](../../getting-started/glossary.md#agent) — one-line definition of the construct this provider drives.
