# @ethosagent/llm-azure

## Purpose

Azure OpenAI `LLMProvider` for Ethos. It drives the `AzureOpenAI` client from the `openai` package (api-key header, deployment-name routing, `api-version` query param) and reuses the Chat Completions request building and stream translation from `llm-openai-compat`. Model catalog, retries across providers and secret storage stay with the wiring layer.

## Public surface

Single entry point `.` (`./src/index.ts`, `./dist/index.js` in production).

| Export | Kind | One line |
|---|---|---|
| `AzureOpenAIProvider` | class | `LLMProvider` for one Azure deployment. |
| `AzureOpenAIProviderConfig` | type | Name, deployment, key, endpoint, apiVersion, optional retries and `outputCapParam`. |
| `azureFactory` | const | `LLMProviderFactory`; reads the key from `providers/azure/apiKey`, falling back to config. |
| `activate` | function | Plugin entry; registers the factory as provider `azure`. |
| `AZURE_DEFAULT_API_VERSION` | const | API version used when config sets none. |
| `PROVIDER_CONTRACT_MAJOR` | const | Provider contract major this package targets (3). |

## Seam

Implements `LLMProvider` from `@ethosagent/types` and registers through `EthosPluginApi.registerLLMProvider` from `@ethosagent/plugin-sdk`. Archcheck layer `extensions` (rule `extensions-implement-contracts`).

`outputCapParam` other than `max_tokens` or `max_completion_tokens` is rejected: `extensions/llm-azure/src/__tests__/output-cap-param.test.ts` ("refuses any other value at construction").

## Testing

```
pnpm vitest run extensions/llm-azure
```

- `src/__tests__/conformance.test.ts` holds client construction args (endpoint, apiVersion, key), that only canonical `CompletionChunk` types are yielded, and that `countTokens` is a positive integer.
- `src/__tests__/output-cap-param.test.ts` holds the output-cap parameter choice for reasoning deployments and the construction-time refusal of bad values.
