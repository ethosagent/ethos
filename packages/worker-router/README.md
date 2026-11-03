# @ethosagent/worker-router

## Purpose

Decides where a worker's question goes: a cached answer, an auto-resolving capability, or a human, from an `InteractionRequest` alone. It is runner-agnostic; a harness is a caller of `InteractionRouter.route()`, not a second router. A `secret` request is never escalated to a human; it raises `SecretUnavailableError` instead.

## Public surface

Single entry point `.` (`src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `InteractionRouter` | class | Routes a request to cache, capability or escalator. |
| `InteractionRouterOptions` | type | Options for `InteractionRouter`. |
| `InteractionEscalator` | type | The human-facing escalation seam. |
| `CapabilityHandler` | type | A handler that may auto-resolve one request kind. |
| `CapabilityRegistry` | type | Registry of capability handlers by kind. |
| `createClarifyEscalator` | function | Escalator that asks the human in the job's own lane and session. |
| `ClarifyEscalatorDeps` | type | Dependencies of `createClarifyEscalator`. |
| `DEFAULT_ESCALATION_TIMEOUT_MS` | const | Default wait for a question that has a default answer. |
| `DEFAULT_PARK_TIMEOUT_MS` | const | Default park time for a question with no default. |
| `RUN_SCOPE_ANSWER` | const | Marker for an answer scoped to the whole run. |
| `createSecretHandler` | function | Capability handler for the `secret` kind. |
| `SECRET_KIND` | const | The `secret` request kind. |
| `SecretUnavailableError` | class | Raised instead of asking a human for secret material. |

## Seam

Support-layer package (see `architecture.config.ts`). It depends on `@ethosagent/core` and `@ethosagent/types`. The routing rules are pinned by `src/__tests__/router.test.ts`.

## Testing

```
pnpm vitest run packages/worker-router
```

- `src/__tests__/router.test.ts`: a kind a capability auto-resolves never reaches the human; an unknown kind escalates rather than throwing.
- `src/__tests__/clarify-escalator.test.ts`: lane and session of the question, and the two timeout clocks.
