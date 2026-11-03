# @ethosagent/llm-codex

## Purpose

OpenAI Codex `LLMProvider` for Ethos, authenticated with a ChatGPT OAuth device-code login rather than an API key. It converts Ethos messages and tools to the Responses API, streams the reply as `CompletionChunk`s and keeps the OAuth tokens fresh. The Responses transport and converters are also reused by `llm-xai`.

## Public surface

Single entry point `.` (`./src/index.ts`, `./dist/index.js` in production). Main entry points, grouped by source file.

| Export | Kind | One line |
|---|---|---|
| `CodexProvider` | class | `LLMProvider` backed by the Codex Responses endpoint. |
| `CodexProviderConfig` | type | Model, token getter, logger, optional retries. |
| `codexFactory` | const | `LLMProviderFactory`; builds the provider over a `CodexTokenStore`. |
| `activate` | function | Plugin entry; registers the factory as provider `codex`. |
| `PROVIDER_CONTRACT_MAJOR` | const | Provider contract major this package targets (3). |
| `CodexTokenStore` | class | Loads, saves, refreshes and migrates OAuth credentials via secrets. |
| `CodexCredentials` | type | Stored OAuth credential shape. |
| `requestDeviceCode` | function | Starts the device-code login. |
| `pollForAuthorization` | function | Polls until the user approves the device code. |
| `exchangeForTokens` | function | Exchanges the authorization for tokens. |
| `discoverModels` | function | Fetches the live model roster, falling back on failure. |
| `CODEX_FALLBACK_MODELS` | const | Roster used when discovery fails. |
| `CODEX_MODELS_URL` | const | Roster endpoint. |
| `ModelDiscovery` | type | Result of model discovery. |
| `resetModelDiscoveryCache` | function | Clears the roster cache. |
| `unsupportedModelMessage` | function | Builds the supported-model hint. |
| `toResponsesInput` | function | Messages to Responses input items. |
| `toResponsesTools` | function | Tool definitions to Responses tools. |
| `streamResponsesApi` | function | Streams a Responses call as chunks. |
| `ResponsesApiBody` | type | Request body for `streamResponsesApi`. |
| `ResponsesApiError` | class | Error carrying the vendor code and message. |

## Seam

Implements `LLMProvider` from `@ethosagent/types`; registers via `EthosPluginApi.registerLLMProvider` (`@ethosagent/plugin-sdk`). Archcheck layer `extensions` (rule `extensions-implement-contracts`).

- `response.failed`, `error`, content-filter incompletes and truncated streams throw rather than finish silently: `src/__tests__/responses-events.test.ts`.
- `max_output_tokens` is not forwarded to the Responses API: `src/__tests__/conformance.test.ts`.
- Concurrent callers share one token refresh: `src/__tests__/token-store.test.ts`.

## Testing

```
pnpm vitest run extensions/llm-codex
```

- `src/__tests__/conformance.test.ts` holds chunk types, tool-call events, usage and finish reasons.
- `src/__tests__/responses-events.test.ts` holds terminal Responses events and their error mapping.
- `src/__tests__/responses-adapter.test.ts` holds message and tool conversion.
- `src/__tests__/token-store.test.ts` holds save/load, refresh, legacy migration and single-flight refresh.
- `src/__tests__/models.test.ts` holds discovery, fallback and the cache TTL.
- `src/__tests__/transport.test.ts` holds optional body fields and vendor-labelled errors.
