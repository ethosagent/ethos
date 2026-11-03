---
title: "config.yaml: model registry and provider chain"
description: "config.yaml model registry, output-token caps and provider chain."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Keys that describe models and chain providers for failover. Part of the [config.yaml reference](../config-yaml.md).

## modelRegistry.\* {#model-registry}

Type: dotted block · Default: unset (the legacy [`model`](provider-and-model.md#model) serves)

The deployment's roster of model **aliases**. A personality's [`model`](../personality-yaml.md#model) names an alias or a role, and the registry turns it into a provider entry and a vendor model id. Parsed by `buildModelRegistry` in [`packages/config/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/config/src/index.ts); the type is `ModelRegistryEntry` in [`packages/types/src/model-registry.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/model-registry.ts).

| Field | Type | Description |
|---|---|---|
| `modelRegistry.<alias>.provider` | string | The provider entry's explicit `providers.<i>.id`, not a provider type. |
| `modelRegistry.<alias>.modelId` | string | The vendor id sent on the wire, e.g. `claude-opus-4-8`. |
| `modelRegistry.<alias>.label` | string | Label shown in the model pickers. Display only. |
| `modelRegistry.<alias>.contextWindow` | integer | Context window in tokens. |
| `modelRegistry.<alias>.effort` | `off` \| `low` \| `medium` \| `high` | How hard this alias reasons. Unset sends each provider's own default request. See [Effort mapping](#model-registry-effort). |
| `modelRegistry.<alias>.costPer1kInput` / `.costPer1kOutput` | number | USD per 1k tokens. Display only; nothing bills on it. |
| `modelRegistry.<alias>.fallbacks` | comma list | Aliases tried in order when this entry's provider cannot answer. Same provider entry only. |
| `modelRegistry.default` | alias | The alias a turn uses when nothing else declares one. |
| `modelRegistry.roles.<role>` | alias | Binds a role (`trivial`, `default`, `deep`, `dreaming`) to an alias. |

```yaml
modelRegistry.opus-deep.provider: anthropic-main
modelRegistry.opus-deep.modelId: claude-opus-4-8
modelRegistry.opus-deep.effort: high
modelRegistry.opus-quick.provider: anthropic-main
modelRegistry.opus-quick.modelId: claude-opus-4-8
modelRegistry.opus-quick.effort: low
modelRegistry.default: opus-quick
modelRegistry.roles.deep: opus-deep
```

Two aliases can share one `modelId` and differ only in `effort`. A personality picks one by name (`model: opus-deep`), so effort needs no personality field.

Notes:

- `effort` values: `off` — no extended reasoning where the model allows it; `low`, `medium`, `high` — increasing reasoning depth and token spend. There is no default value: an alias with no `effort` sends exactly the request it sent before the key existed.
- An `effort` outside those four is dropped, and the config load prints `config.yaml: 'modelRegistry.<alias>.effort' must be one of off, low, medium, high ('<value>'), so it was ignored.`
- The effort travels with the alias that answers. A mid-turn escalation to another alias sends that alias's effort, or none. On an unpinned turn a `providers.*` failover hop receives the same effort and maps it onto its own model.

### Effort mapping {#model-registry-effort}

Each provider maps `effort` to its own request field, or ignores it.

| Provider | What `effort` sends |
|---|---|
| `anthropic`, adaptive-thinking models (Opus 4.6, 4.7, 4.8, 5, 5.5; Sonnet 4.6, 5; Fable 5, 5.1) | `low`/`medium`/`high` → `thinking: {type: adaptive}` plus `output_config.effort`. `off` → nothing on a model that does not think by default (Opus 4.6–4.8, Sonnet 4.6); `thinking: {type: disabled}` plus effort `low` on Opus 5; effort `low` alone on a model whose thinking cannot be disabled (Opus 5.5, Sonnet 5, Fable 5 and 5.1). |
| `anthropic`, budget-thinking models (Haiku 4.5, Sonnet 4.5, Opus 4.5, Opus 4.1, Opus 4, Sonnet 4, Claude 3.7 Sonnet) | `thinking.budget_tokens`: `low` 1024, `medium` 4096, `high` 16,384; `off` sends no thinking. The budget is capped at the request's `max_tokens` minus 1024 and dropped below 1024, so `high` under an 8,096-token cap (a Claude model the catalog does not list) thinks with 7,072. Raise [`models.<provider>/<model>.maxOutputTokens`](#models-max-output-tokens) to give it the full budget. |
| `anthropic`, any other model id | Nothing. |
| `codex` | `reasoning.effort`: `low`, `medium` or `high`; `off` → `low`. Unset stays `medium`, the value it always sent. |
| `openai` and other OpenAI-compatible providers | `reasoning_effort`, only for an OpenAI reasoning model (o-series, GPT-5 family) on `api.openai.com`; `off` → `low`; `gpt-5-pro` always gets `high`. `gpt-5-chat`, `o1-mini` and `o1-preview` get nothing. OpenRouter, local runtimes and Azure get nothing. |
| `gemini`, `xai`, `bedrock`, `azure` | Nothing. The request is unchanged. |

Notes:

- **Tool continuations.** The Anthropic provider cannot send a previous turn's thinking block back to the API. So when a request continues a turn that called a tool, a budget-thinking model sends no thinking, and an adaptive model that does not think by default sends `output_config.effort` without a `thinking` param. Models that think by default send the same request as on any other turn. `thinkingParamsFor` and `continuesToolUseTurn` in [`extensions/llm-anthropic/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/llm-anthropic/src/index.ts); pinned by `extensions/llm-anthropic/src/__tests__/thinking-capabilities.test.ts`.
- The Anthropic capability table is `ANTHROPIC_MODEL_CAPABILITIES` in the same file. Dated snapshots, `-latest`, Bedrock, Vertex and OpenRouter spellings of a model id map to the same row.
- The Codex mapping is `codexEffort` in [`extensions/llm-codex/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/llm-codex/src/index.ts); the OpenAI mapping is `openAiReasoningEffort` in [`extensions/llm-openai-compat/src/transport.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/llm-openai-compat/src/transport.ts).

## models.\<provider\>/\<model\>.maxOutputTokens {#models-max-output-tokens}

Type: integer · Default: the model catalog's cap for that model, else the provider's default

The output-token cap sent with each request to that model. It beats the bundled [model catalog](../../../building/reference/model-catalog.md) (`mergeModelProfile`, `packages/wiring/src/model-catalog.ts`). The catalog records the documented cap for each Claude model on `provider: anthropic`: 128,000, or 64,000 for Claude Haiku 4.5. A Claude model the catalog does not list gets 8,096. The `anthropic` provider and OpenAI-compatible providers such as `openrouter` read this key. `azure` and `bedrock` do not.

```yaml
models.anthropic/claude-opus-5.maxOutputTokens: 32000
```

## providers.\<i\>.\* {#providers-chain}

Provider fallback chain. When two or more entries are present, the runtime wraps them in a `ChainedProvider` with cooldown-based failover. Index `0` is primary; higher indices fall back in order. With fewer than two entries, the top-level `provider` / `apiKey` / `model` fields are used instead. When Settings or `ethos fallback add` grows a chain from the top-level fields, entry `0` becomes the top-level provider, with the same key reference.

| Field | Type | Description |
|---|---|---|
| `providers.<i>.provider` | string | Provider id for entry `<i>`. |
| `providers.<i>.apiKey` | string | API key for entry `<i>`. |
| `providers.<i>.model` | string | Optional model override for entry `<i>`. |
| `providers.<i>.baseUrl` | string | Optional endpoint override for entry `<i>`. |
| `providers.<i>.apiVersion` | string | Azure only: REST API version for entry `<i>`. |
| `providers.<i>.region` | string | Bedrock only: AWS region for entry `<i>`. |
| `providers.<i>.awsProfile` | string | Bedrock only: named AWS profile for entry `<i>`. |
| `providers.<i>.outputCapParam` | `max_tokens` \| `max_completion_tokens` | Azure only: the output-cap parameter entry `<i>`'s deployment is sent. Default: `max_completion_tokens` when the deployment name is a reasoning model id (`o4-mini`, `gpt-5-mini`), `max_tokens` otherwise. Set `max_completion_tokens` for a reasoning deployment with any other name. Any other value is ignored with a warning at startup. The top-level fields count as entry `0`. Settable at provision time via `AZURE_OUTPUT_CAP_PARAM` (`ethos setup --from-env`, see [Run Ethos in Docker](../../how-to/run-in-docker.md)). |
| `providers.<i>.serverCompaction` | boolean | Anthropic only. `true` lets the provider compact the conversation server-side instead of the local context engine. Default off. See [Server-side compaction](#server-compaction). |
| `providers.<i>.serverCompactionTriggerTokens` | integer | Input-token count at which the server compacts. Default: the local compaction threshold for the model. A value below 50,000, the minimum in Anthropic's API documentation, is raised to 50,000 rather than rejected. |

Any other `providers.<i>.<field>` line belongs to entry `<i>`: it moves with the entry when the chain is reordered and is removed with it. Its value is checked for plaintext credentials at boot like every other value. If one is found, Ethos refuses to start and names the line — run `ethos secrets set providers/<i>/<field> <value>`, then set the line to `providers.<i>.<field>: ${secrets:providers/<i>/<field>}`.

```yaml
providers.0.provider: anthropic
providers.0.apiKey: sk-ant-...
providers.0.model: claude-opus-4-7
providers.1.provider: openrouter
providers.1.apiKey: sk-or-...
providers.1.model: anthropic/claude-opus-4-7
```

### Server-side compaction {#server-compaction}

With `providers.<i>.serverCompaction: true` on an `anthropic` entry, Anthropic summarizes the older turns itself once a request's input reaches the trigger (the `compact_20260112` edit, beta `compact-2026-01-12`). The local context engine then stays out of the way for every turn that entry serves: the pre-request compaction, the overflow retry and the turn-end auto-compaction do not run, so a turn never compacts twice. The top-level spelling counts as entry `0`, so a single-provider setup turns it on with `providers.0.provider: anthropic` plus `providers.0.serverCompaction: true`.

- The trigger defaults to the threshold the local gate would compact at (`compaction.pressure` of the model's window, capped by `compaction.maxContextTokens`), so turning the switch on changes who compacts, not when.
- The summary block is saved in `sessions.db` as one extra assistant row and sent back on every later request, as the API requires. Transcripts, exports and search show it as `— context compacted by the provider —` followed by the summary; the encrypted part is stored outside the searchable text.
- On any other provider the flag is ignored with a warning at startup.
- If the API refuses the edit (an unsupported model, for example), the request is retried once without it, an `audit.compaction` event with code `llm.server_compaction_rejected` lands in `observability.db`, and local compaction runs for the rest of that turn.
- After a failover to a non-Anthropic provider, the saved summary reaches it as plain assistant text; the encrypted half is Anthropic-only and is dropped.

```yaml
providers.0.provider: anthropic
providers.0.apiKey: ${secrets:providers/0/anthropic/apiKey}
providers.0.serverCompaction: true
providers.0.serverCompactionTriggerTokens: 150000
```

A compaction shows up as an assistant row that starts with the marker line, and as an `llm.server_compacted` event. `ANTHROPIC_LOG=debug` prints each request body, where the next request carries the block back:

```bash
sqlite3 ~/.ethos/sessions.db "SELECT role, substr(content, 1, 80) FROM messages WHERE tool_name = '_provider_compaction';"
sqlite3 ~/.ethos/observability.db "SELECT code, cause FROM events WHERE code LIKE 'llm.server_compact%';"
```

## See also {#see-also}

- [config.yaml reference](../config-yaml.md): the index of every section and its page.
