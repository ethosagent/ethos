# @ethosagent/llm-openai-compat

`LLMProvider` implementation for any OpenAI-compatible Chat Completions endpoint — OpenAI itself, OpenRouter, Ollama, Google Gemini's compat shim, DeepSeek, Mistral, etc.

## Why this exists

A single OpenAI-shaped client covers most non-Anthropic providers. This package adapts that one wire format to Ethos's provider contract so the CLI can route to local Ollama, an OpenRouter aggregate, or Gemini without a per-vendor adapter. It also handles two real-world wrinkles: Gemini rejects several JSON Schema fields OpenAI accepts, and OpenAI streams tool calls indexed by position rather than ID.

## What it provides

- `OpenAICompatProvider` — implements `LLMProvider` for any base URL that speaks the OpenAI Chat Completions wire format.
- `OpenAICompatProviderConfig` — `{ name, model, apiKey, baseUrl, maxContextTokens? }`.
- `normalizeGeminiSchema` — exported helper that strips fields Gemini's compat layer rejects (`minLength`, `maxLength`, `pattern`, `format`, `$schema`, `additionalProperties`) and collapses array-typed `type` fields.

## How it works

`toOpenAIMessages` (`src/index.ts:74`) flattens Ethos's `MessageContent[]` blocks into the OpenAI shape. User `tool_result` blocks become separate `role: 'tool'` messages keyed by `tool_call_id`. Assistant messages with `tool_use` blocks become a single message with a `tool_calls` array; text and tool calls coexist on one assistant message because OpenAI requires it.

Streaming tool calls is the biggest difference from Anthropic. OpenAI delivers them as deltas on `choices[0].delta.tool_calls[index]`, where the *first* delta for a given numeric `index` carries the `id` and `name` and subsequent deltas carry only `arguments` chunks. The provider keeps a `Map<number, { id, name, args }>` keyed by index (`src/index.ts:228`) and emits `tool_use_start` once per index, `tool_use_delta` per arguments fragment, and `tool_use_end` at `finish_reason`. Do not key by `id` — it shows up late and may be empty on early deltas.

Usage arrives in its own chunk when `stream_options.include_usage: true` is set, signalled by `chunk.usage` being present and `chunk.choices[0]` being absent (`src/index.ts:234`). Cost is estimated by `estimateCost` from `@ethosagent/pricing`, the one cache-aware rate table shared by every provider extension. A call served by a classified local runtime costs 0 by construction; any other unrecognised model costs 0 and reports `pricing.unknown_model` so the gap is visible.

If the `baseUrl` host is `generativelanguage.googleapis.com`, `normalizeGeminiSchema` is applied to every tool's `parameters` before send (`src/index.ts:207`). It recursively strips the offending keys and rewrites `type: ["string", "null"]` to the first non-`null` entry.

`countTokens` is a 4-chars-per-token approximation since OpenAI-compat providers don't expose a counting endpoint.

## Gotchas

- OpenAI's `openai@4.87+` has a peer-dep on `zod@^3`. Ethos uses `zod@4` and never touches the structured-output features that depend on zod. The conflict is silenced via `peerDependencyRules.ignoreMissing` in `pnpm-workspace.yaml` — leave it alone.
- The Gemini detection is host-substring-based. If a future Gemini compat URL changes, update `isGeminiEndpoint` (`src/index.ts:66`).
- `supportsCaching` and `supportsThinking` are hard-coded `false` — neither concept maps cleanly across this many backends.
- `countTokens` is an estimate, not authoritative. Don't use it for billing.
- The output cap goes on the wire as `max_completion_tokens` for `api.openai.com` and for a bare OpenAI reasoning-family model id (`o<digit>…`, `gpt-5…`) on any hosted endpoint — those models refuse `max_tokens`. Everything else, local runtimes included, keeps `max_tokens` (`outputCapParam` in `src/transport.ts`, pinned by `src/__tests__/max-completion-tokens.test.ts`).
- On Azure the model id is the deployment name, so the same rule reads the deployment name: name a reasoning deployment after its model (`o3-mini`, `gpt-5-mini` — the Azure portal's default) and it gets `max_completion_tokens`. A reasoning deployment under any other name needs `providers.<n>.outputCapParam: max_completion_tokens` in config.yaml: @ethosagent/llm-azure passes it to `buildChatCompletionsParamsAsync` as an `outputCapParam` override, which wins over the name rule (pinned by `extensions/llm-azure/src/__tests__/output-cap-param.test.ts`). Without it, that deployment is sent `max_tokens` and Azure refuses it. `max_completion_tokens` is not sent to every Azure deployment because no one has verified that every Azure api-version (this provider's Azure branch pins `2024-08-01-preview`) accepts it for non-reasoning models.
- On the Gemini endpoint a tool call's `extra_content.google.thought_signature` is remembered by the provider instance, keyed by tool-call id, and sent back on that tool call in the next request (Gemini 3 refuses the follow-up without it). Process-lifetime only: a restart mid tool loop loses it (`OpenAICompatProvider.thoughtSignatures`, pinned by `src/__tests__/gemini-thought-signature.test.ts`).

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `OpenAICompatProvider`, message conversion, Gemini schema normalization, pricing table. |
