---
title: "LLM provider interface: completion options, chunks, usage and failover"
description: "CompletionOptions, CompletionChunk, TokenUsage and FailoverReason."
kind: reference
audience: developer
updated: 2026-11-03
---

## Synopsis {#synopsis}

The request options, streamed chunks, usage counts and failover reasons of a provider call. Part of the [LLM provider interface reference](../llm-provider-interface.md).

## CompletionOptions {#completion-options}

### Signature {#completion-options-signature}

```ts
export interface CompletionOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  thinkingBudget?: number;
  cacheSystemPrompt?: boolean;
  abortSignal?: AbortSignal;
  stopSequences?: string[];
  modelOverride?: string;
}
```

### Members {#completion-options-members}

| Field | Type | Description |
|---|---|---|
| `system` | `string` | System prompt. Built by `AgentLoop` from `SOUL.md` + memory + injectors. |
| `maxTokens` | `number` | Maximum tokens in the response. Defaults vary by provider. |
| `temperature` | `number` | Sampling temperature. Most surfaces use `0` or `0.2`. |
| `thinkingBudget` | `number` | Token budget for extended thinking. Ignored if `supportsThinking` is false. |
| `cacheSystemPrompt` | `boolean` | Opt into provider-side prompt caching. Ignored if `supportsCaching` is false. |
| `abortSignal` | `AbortSignal` | Same signal threaded through `ToolContext.abortSignal`. Cancel the in-flight call when it fires. |
| `stopSequences` | `string[]` | Hard stop strings. Match any one and the stream ends with `done.finishReason === 'stop_sequence'`. |
| `modelOverride` | `string` | Per-call model override. Used by the routing layer to send a turn to a different model than the provider default. |

## CompletionChunk {#completion-chunk}

The streaming event type yielded by `complete()`. Nine variants, frozen: `packages/types/src/__tests__/llm-provider-drift.test.ts` fails if one is added or removed without a §VI amendment ([LLM provider governance](../../explanation/llm-provider-governance.md)).

### Signature {#completion-chunk-signature}

```ts
export type CompletionChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_use_start'; toolCallId: string; toolName: string }
  | { type: 'tool_use_delta'; toolCallId: string; partialJson: string }
  | { type: 'tool_use_end'; toolCallId: string; inputJson: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; finishReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' }
  | { type: 'warning'; message: string }
  | { type: 'compaction'; content: string | null; encryptedContent: string | null };
```

The `usage` variant carries three optional fields not shown here (`metadata`, `providerRequestId`, `costBasis`); the full declaration is in [`packages/types/src/llm.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/llm.ts).

### Variants {#completion-chunk-variants}

| `type` | When emitted | Payload |
|---|---|---|
| [`text_delta`](#text-delta) | Each chunk of assistant text. | `text: string` |
| [`thinking_delta`](#thinking-delta) | Each chunk of extended-thinking output. | `thinking: string` |
| [`tool_use_start`](#tool-use-start) | When the LLM begins a tool call. | `toolCallId`, `toolName` |
| [`tool_use_delta`](#tool-use-delta) | Streaming JSON args for the in-progress tool call. | `toolCallId`, `partialJson` |
| [`tool_use_end`](#tool-use-end) | When the LLM finishes the tool-call args. | `toolCallId`, `inputJson` |
| [`usage`](#usage) | Once, at the end of the response. | `usage: TokenUsage` |
| [`done`](#done) | Exactly once, last chunk in the stream. | `finishReason` |
| [`warning`](#warning) | A non-fatal provider notice. | `message: string` |
| [`compaction`](#compaction) | The provider compacted the conversation server-side. Anthropic only. | `content`, `encryptedContent` |

#### text_delta {#text-delta}

Append `text` to the current assistant message. Whitespace is preserved as-is.

#### thinking_delta {#thinking-delta}

Extended-thinking output. Emit only when `supportsThinking` is true and `options.thinkingBudget` is set.

#### tool_use_start {#tool-use-start}

Provider has decided to call `toolName` with stable id `toolCallId`. Subsequent `tool_use_delta` chunks with the same id stream the args JSON.

#### tool_use_delta {#tool-use-delta}

Append `partialJson` to the in-progress args buffer for `toolCallId`. Providers that don't stream args may emit zero of these and supply the full payload via `tool_use_end.inputJson`.

#### tool_use_end {#tool-use-end}

The complete args JSON for `toolCallId`. After this chunk the assembled call is handed to `ToolRegistry.executeParallel`.

#### usage {#usage}

Token accounting for the call. `TokenUsage` carries `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `estimatedCostUsd`.

#### done {#done}

Final chunk. `finishReason` tells the loop whether to feed tool results back (`tool_use`) or end the turn (`end_turn`, `max_tokens`, `stop_sequence`).

Report `max_tokens` whenever the output token cap stopped the call, because the loop acts on it (`packages/core/src/agent-loop/output-cap.ts`):

- A reply cut off at the cap is kept as it is, and the user sees a `⚠ reply cut off` notice after its text (`MAX_TOKENS_REPLY_NOTICE`, yielded by `packages/core/src/agent-loop/stages/text-end.ts`).
- A tool call whose arguments the cap cut off does not run. The model gets a rejection naming the cap and asking it to split the work (`rejectCutOffToolCalls`), not the generic "malformed tool arguments" text. A call whose JSON parsed strictly was complete and still runs.
- A turn that ends with no reply text yields an `error` event with code `empty_completion` when the cap cut it off or when it ran no tool at all. Its message says whether the cap was the cause (`emptyCompletionError`). A turn that did its work through tools and then stopped without text ends with a normal, blank `done` (`settleTextEnd` in `packages/core/src/agent-loop/stages/text-end.ts`, pinned by `packages/core/src/__tests__/silent-tool-turn.test.ts`).

#### warning {#warning}

A non-fatal notice from the provider. The stream continues. `AnthropicProvider` emits `SERVER_COMPACTION_REJECTED_WARNING` when the API refused the compaction edit and the request was retried without it.

#### compaction {#compaction}

A server-side compaction block. `content` is the readable summary, or `null` when the server failed to produce one. `encryptedContent` is opaque provider state that must be sent back byte for byte. The agent loop persists the block and replays it on every later request; the API then ignores everything before it. Emitted only by `AnthropicProvider` with `providers.<i>.serverCompaction: true`. Other providers never emit it and receive the summary as plain assistant text (`flattenCompactionEnvelopes` in `packages/types/src/llm.ts`).

### Notes {#completion-chunk-notes}

- The stream must end with exactly one `done`. Emitting `done` mid-stream truncates the response.
- `usage` typically arrives just before `done`. Providers that surface usage on the first chunk (Anthropic `message_start`) may emit it earlier — consumers should not assume order beyond `done` being last.
- `tool_use_delta` is optional. A provider that surfaces fully-formed args may emit only `tool_use_start` and `tool_use_end`.
- Provider implementations index streaming tool calls by their stable id (`toolCallId`). OpenAI streams them index-keyed on `choices[0].delta.tool_calls[index]`; the provider implementation rebuilds the id mapping from the first delta. Anthropic streams `content_block_start` / `content_block_delta` events with the id embedded.
- Cache tokens (`cacheReadTokens`, `cacheCreationTokens`) are non-zero only when `supportsCaching` is true and `options.cacheSystemPrompt` was set. Providers without cache support report `0`.

## TokenUsage {#token-usage}

```ts
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
}
```

| Field | Description |
|---|---|
| `inputTokens` | Prompt tokens billed (non-cached). |
| `outputTokens` | Completion tokens billed. |
| `cacheReadTokens` | Prompt tokens served from cache. Zero when caching is off. |
| `cacheCreationTokens` | Tokens written into cache on this call. |
| `estimatedCostUsd` | Provider-side cost estimate. Surfaced in the `AgentEvent.usage` event verbatim. |

## FailoverReason {#failover-reason}

Used by `AuthRotatingProvider` and similar wrappers to decide whether to rotate auth profiles. Stable string union:

```ts
export type FailoverReason =
  | 'auth'
  | 'rate_limit'
  | 'overloaded'
  | 'context_overflow'
  | 'timeout'
  | 'network'
  | 'model_not_found'
  | 'content_filter'
  | 'unknown';
```

Providers map their error taxonomy to one of these so the wrapper logic stays provider-agnostic.

## See also {#see-also}

- [LLM provider interface reference](../llm-provider-interface.md): the index of every section and its page.
