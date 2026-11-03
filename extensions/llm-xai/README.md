# @ethosagent/llm-xai

## Purpose

xAI (Grok) `LLMProvider` for Ethos, speaking the OpenAI Responses API. It reuses the request conversion and streaming transport from `@ethosagent/llm-codex`, so it owns only the xAI endpoint, defaults, error rewording and request-body choices. It validates no model names locally; the vendor is the authority.

## Public surface

Single entry point `.` (`./src/index.ts`, `./dist/index.js` in production).

| Export | Kind | One line |
|---|---|---|
| `XaiProvider` | class | `LLMProvider` for xAI Grok models. |
| `XaiProviderConfig` | type | Model, key, optional context window and retries. |
| `xaiFactory` | const | `LLMProviderFactory`; key from `providers/xai/apiKey`, falling back to config. |
| `activate` | function | Plugin entry; registers the factory as provider `xai`. |
| `decorateModelError` | function | Rewrites an unknown-model failure, keeping the `model_not_found` token. |
| `XAI_BASE_URL` | const | Pinned API base, `https://api.x.ai/v1`. |
| `XAI_RESPONSES_ENDPOINT` | const | `XAI_BASE_URL` plus `/responses`. |
| `XAI_DEFAULT_MODEL` | const | Seed model used when config sets none. |
| `XAI_SECRET_REF` | const | Secret ref shared with the `x_search` tool. |
| `PROVIDER_CONTRACT_MAJOR` | const | Provider contract major this package targets (3). |

## Seam

Implements `LLMProvider` from `@ethosagent/types`; registers via `EthosPluginApi.registerLLMProvider` (`@ethosagent/plugin-sdk`). Archcheck layer `extensions` (rule `extensions-implement-contracts`).

Requests post to the pinned endpoint and never carry `stop`, `presence_penalty`, `frequency_penalty`, `temperature`, `top_p` or `seed`: `src/__tests__/request-body.test.ts`.

Limitation: no xAI response has been recorded from this repo; the Responses parsing is proven against OpenAI only (comment at the top of `src/index.ts`).

## Testing

```
pnpm vitest run extensions/llm-xai
```

- `src/__tests__/conformance.test.ts` holds canonical chunk types, usage reporting and honest capability flags.
- `src/__tests__/request-body.test.ts` holds the request body fields, the pinned endpoint, `modelOverride` and `xaiFactory` behaviour.
- `src/__tests__/transient-retry.test.ts` holds one retry of a 429, no retry with `maxRetries: 0`, and `response.failed` surfacing as an error naming xAI.
