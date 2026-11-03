# ADR 0006 — LLM providers are thin adapters over a transport

## Status

Accepted. Moved verbatim from ARCHITECTURE.md §IV on 2026-11-03 as a Clarifying amendment (ARCHITECTURE.md §VI). No law changed scope.

## Context

A new LLM provider maps personality routing onto a streaming function. Putting a streaming loop in each provider would duplicate retry, chunk and error handling.

## Decision

### LLM Provider Authoring

A new LLM provider is a thin adapter that maps personality routing to a
transport function. A provider must not contain a streaming loop. If the
wire protocol is already supported by an existing transport, reuse it. If
it is not, extract a new transport first, then write the provider against
it.

**Decision tree — which transport to use:**

- Provider speaks the OpenAI Chat Completions wire format → use
  `streamChatCompletions` from `@ethosagent/llm-openai-compat`.
- Provider speaks the Anthropic Messages wire format → use
  `streamAnthropicMessages` from `@ethosagent/llm-anthropic`.
- Provider speaks the OpenAI Responses API (SSE) → use
  `streamResponsesApi` from `@ethosagent/llm-codex`.
- Provider speaks the AWS Bedrock Converse API → use
  `streamBedrockConverse` from `@ethosagent/llm-bedrock`.
- None of the above → write a new transport, then write the provider.

**Transport table:**

| Transport | Package | Wire protocol |
|---|---|---|
| `streamChatCompletions` | `@ethosagent/llm-openai-compat` | OpenAI Chat Completions |
| `streamAnthropicMessages` | `@ethosagent/llm-anthropic` | Anthropic Messages API |
| `streamResponsesApi` | `@ethosagent/llm-codex` | OpenAI Responses API (SSE) |
| `streamBedrockConverse` | `@ethosagent/llm-bedrock` | AWS Bedrock Converse API |

## Consequences

A provider for a known wire format is a small file.
A new wire format costs one transport package first, then a provider.
The transport table is a list of current packages. It grows when a transport lands.

## Enforced by

- `packages/types/src/__tests__/llm-provider-drift.test.ts` pins the chunk union and provider surface.
- `checkChunkVariants` in `packages/wiring/src/conformance/index.ts` checks consumers against the chunk set.
- Not mechanically enforced (known gap): that a provider contains no streaming loop.
