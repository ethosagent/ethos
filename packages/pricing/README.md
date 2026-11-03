# @ethosagent/pricing

## Purpose

The single cache-aware LLM rate table and `estimateCost()`, so token-to-USD conversion happens in one place for every provider extension. Prices input, output, cache-read and cache-creation tokens at separate rates, and applies a tier break above a prompt-token threshold where the table defines one. Depends only on `@ethosagent/types`.

## Public surface

| Export | Kind | One line |
|---|---|---|
| `estimateCost` | function | Returns `{ costUsd, basis }` for a model and token counts. |
| `findRate` | function | Looks up the `ModelRate` for a model id. |
| `MODEL_PRICING` | const | The rate table. |
| `ModelRate` | type | Per-million-token rates for one model. |
| `TierBreak` | type | Higher rate applied above a prompt-token threshold. |
| `CostTokens` | type | Token buckets accepted by `estimateCost`. |
| `CostEstimate` | interface | Result of `estimateCost`. |
| `PricingBasis` | type | `'priced' \| 'local' \| 'unknown'`. |
| `EstimateCostOptions` | interface | Options, including `localRuntime`. |
| `setUnknownModelReporter` | function | Installs a callback invoked for unpriced models. |
| `resetUnknownModelReports` | function | Clears the once-per-model report memory. |
| `UnknownModelReporter` | type | Callback signature for unknown models. |

## Seam

Archcheck layer `support`. Unknown models return `costUsd: 0` with basis `unknown` instead of a guessed price, pinned by `src/__tests__/pricing.test.ts` ("returns 0 for an unknown model instead of guessing").

## Testing

```
pnpm vitest run packages/pricing
```

- `src/__tests__/pricing.test.ts`: each token bucket priced at its own rate, cache reads not priced as input, same model resolved across provider routes, unknown models reported once per model, local runtime costs zero.
