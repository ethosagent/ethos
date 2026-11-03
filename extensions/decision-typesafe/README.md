# @ethosagent/decision-typesafe

## Purpose

`DecisionProvider` backed by TypeSafe's Jev `/v1/systemone` API. `decide()` validates the request, applies a pre-network size guard, consults a circuit breaker, sends one POST and maps the reply into typed answers. Errors come back as data rather than throws. The wire shapes are written from the API reference, not a recorded live response (comment at the top of `src/index.ts`), so tests run against a stub `fetch`.

## Public surface

Single entry point, `src/index.ts` (the only `exports` key in `package.json` is `.`).

| Export | Kind | One line |
|---|---|---|
| `createTypesafeDecisionProvider` | function | Builds the `DecisionProvider` from `TypesafeDecisionProviderOptions`. |
| `TypesafeDecisionProviderOptions` | type | `apiKey`, `model`, `baseUrl`, `timeoutMs`, injectable `fetch`, `now` and `onEvent`. |
| `TYPESAFE_DEFAULT_MODEL` | const | `jev-latest`. |
| `TYPESAFE_DEFAULT_BASE_URL` | const | `https://api.typesafe.ai`. |
| `TYPESAFE_DEFAULT_TIMEOUT_MS` | const | 2000. |
| `postSystemOne` | function | One POST to the `systemone` endpoint; returns a `PostSystemOneResult`. |
| `PostSystemOneOptions` | type | Options for `postSystemOne`. |
| `PostSystemOneResult` | type | Parsed body or a mapped error code. |
| `FetchLike` | type | Injectable `fetch` signature. |
| `validateDecisionRequest` | function | Pure check of what a legal `DecisionRequest` is. |
| `DecisionValidation` | type | `{ ok: true }` or `{ ok: false, code: 'invalid', message }`. |
| `DecisionBreakerEvent` | type | `decision.breaker_open` and `decision.breaker_closed` events passed to `onEvent`. |

## Seam

Implements `DecisionProvider` from `@ethosagent/types` (`packages/types/src/decision.ts`, which also owns `DECISION_LIMITS`; ARCHITECTURE.md lists its method count as a frozen contract). The adapter pattern is `docs/decisions/0007-decision-provider-authoring.md`. Archcheck layer: `extensions`.

Pinned by tests: only `decide` is exposed and errors are returned, never thrown (`src/__tests__/contract.test.ts`); a request over 32k tokens for state plus the longest question, or 64k for all questions, is refused with `too_large` before any request (`src/__tests__/limits.test.ts`); three consecutive health failures open the breaker for 60 s and per-request codes do not count (`src/__tests__/breaker.test.ts`); one request per call and no retries (`src/__tests__/transport.test.ts`).

## Testing

```
pnpm vitest run extensions/decision-typesafe
```

Pinning tests in `src/__tests__/`: `src/__tests__/contract.test.ts`, `src/__tests__/limits.test.ts`, `src/__tests__/breaker.test.ts`, `src/__tests__/mapping.test.ts` (score argmax, choice must have been offered, malformed instead of a default), `src/__tests__/transport.test.ts` (status map, budget and abort signal, wire headers and path). `stub.ts` is the shared fetch stub.
