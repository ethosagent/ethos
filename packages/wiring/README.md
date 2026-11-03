# @ethosagent/wiring

## Purpose

The composition root. `createAgentLoop` assembles an `AgentLoop` from config: LLM providers, the session store, memory, tools, the security-kernel bundle and the execution backend, then returns the loop together with the stores and services an app needs, plus a disposer for shutdown. It also owns the provider and model catalogs, backup and restore, and the gateway and backup locks.

## Public surface

Main entry points from `src/index.ts` (plus roughly 50 more re-exports, see `src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `createAgentLoop` | function | Assembles an `AgentLoop` and its services from `CreateAgentLoopOptions`. |
| `CreateAgentLoopOptions` | interface | Inputs to `createAgentLoop`. |
| `CreateAgentLoopResult` | interface | The loop, goals, usage meter and other services it returns. |
| `WiringConfig` | interface | The config shape wiring reads. |
| `WiringProviderConfig` | interface | One provider entry in `WiringConfig`. |
| `WiringProfile` | type | The calling surface: `cli`, `tui`, `web`, `acp` or `mcp`. |
| `createSessionStore` | function | Builds the session store. |
| `createLLM` | function | Builds the LLM provider for a config. |
| `isProviderAllowed` | function | Whether a provider passes the plugin allowlist. |
| `buildCompressionSummarizer` | function | Builds the context-compression summarizer. |
| `resolveModelTarget` | function | Resolves a model name to a provider and model. |
| `computeModelFit` | function | Scores how well a model fits the configured context. |
| `DisposerStack` | class | Runs registered cleanups in reverse order on shutdown. |
| `IdentityMap` | class | Cross-platform user identity mapping. |
| `cronRunAudience` | function | Room audience for a cron run. |
| `goalRoomAudience` | function | Room audience for a goal run. |
| `createOAuthService` | function | Builds the OAuth service. |
| `createBuiltinVoiceRegistries` | function | Builds the built-in voice registries. |
| `createOutboundPolicyGate` | function | Builds the outbound-policy tool gate. |
| `createOutboxGate` | function | Builds the outbox tool gate. |
| `resolveKanbanDbPath` | function | Resolves the kanban database path. |
| `EnvSecretsResolver` | class | Secrets resolver reading the environment. |
| `FileSecretsResolver` | class | Secrets resolver reading the secrets file. |
| `redactString` | function | Re-export of `@ethosagent/safety-redact`. |
| `acquireGatewayLock` | function | Gateway singleton lock (from `./gateway-lock`). |

Subpath exports (`package.json`): `@ethosagent/wiring/provider-catalog`, `/model-catalog`, `/local-models`, `/types`, `/conformance` (`runConformance`). The app-facing kernel passthrough lives in `src/security-kernel.ts` and is re-exported by the barrel (`export * from './security-kernel'`); `package.json` declares no `/security-kernel` subpath.

## Seam

Wiring layer in `architecture.config.ts`. ARCHITECTURE.md Law 3 (wiring is the only composition root) is enforced by archcheck `l3-wiring-composes`, with the deny side in `l5-apps-through-wiring`, `extensions-implement-contracts`, `support-packages` and `core-adapters-wrap-core`. Law 5 (apps do not bypass wiring) is what `src/security-kernel.ts` serves. `createAgentLoop` is the single owner for the loop and goals pair described in `.claude/rules/agent-loop.md`. The shipped `AgentSafety` bundle passing the core conformance suite is pinned by `src/__tests__/safety-conformance-wiring.test.ts`.

## Testing

```
pnpm vitest run packages/wiring
```

- `src/__tests__/safety-conformance-wiring.test.ts`: the shipped `AgentSafety` bundle passes the core conformance suite and declares a gated approval posture.
- `src/__tests__/catalog-decoupling.test.ts`: provider registration, the core agent loop and the chained provider do not import `model-catalog`.
- `src/__tests__/disposer-stack.test.ts`: cleanups run newest first, every cleanup is attempted, dispose is idempotent.
- `src/__tests__/gateway-lock.test.ts`: the gateway lock refuses a second holder and takes over a dead pid's lock.
- `src/__tests__/conformance.test.ts`: the provider conformance harness.
