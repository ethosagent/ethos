# @ethosagent/a2a

## Purpose

The Agent-to-Agent (A2A) transport and security module: a signed challenge/response handshake, short-lived tokens, JSON-RPC message and task endpoints, an outbound client, and peer/allowlist/nonce/task stores. Trust state is keyed per personality. Identity is injected, and the package imports only from `@ethosagent/types`, `@ethosagent/safety-network` and `hono` per its `package.json` dependencies.

## Public surface

Main entry `@ethosagent/a2a` (HTTP surface, pulls in hono) and `@ethosagent/a2a/crypto` (pure primitives, no hono). Plus more types and helpers, see `src/index.ts`.

| Export | Kind | One line |
|---|---|---|
| `createA2aAuthService` | function | Builds the challenge/response auth service. |
| `createA2aAuthRouter` | function | Hono router for the auth endpoints. |
| `createA2aRpcService` | function | Builds the JSON-RPC service (`message/send`, `tasks/subscribe`). |
| `createA2aRpcRouter` | function | Hono router for the RPC endpoints. |
| `createA2aWellKnownRouter` | function | Serves the well-known agent card. |
| `fetchAndVerifyCard` | function | Fetches a peer card and verifies its signature. |
| `A2aOutboundClient` | class | Outbound client that connects to a peer and sends messages. |
| `A2aAsyncManager` | class | Runs async tasks and streams their results. |
| `A2aDelegationGuard` | class | Admits or refuses delegated calls. |
| `mintToken` | function | Mints an A2A token. |
| `validateToken` | function | Validates a token, including the peer-store revocation check. |
| `signReceipt` | function | Signs an auth receipt. |
| `verifyReceipt` | function | Verifies a signed auth receipt. |
| `StorageA2aPeerStore` | class | Peer store backed by `Storage`. |
| `StorageA2aAllowlist` | class | Allowlist backed by `Storage`. |
| `MemoryNonceStore` | class | In-memory nonce store. |
| `InMemoryA2aTaskStore` | class | In-memory task store. |
| `SQLiteA2aTaskStore` | class | SQLite task store. |
| `MemoryA2aLimiter` | class | In-memory request limiter. |
| `MemoryA2aPreAuthLimiter` | class | In-memory limiter applied before authentication. |
| `A2aUrlRefusedError` | class | Thrown when an outbound URL is refused by egress policy. |

## Seam

Implements the A2A signed-card contract frozen in `packages/types/src/a2a.ts` (ARCHITECTURE.md section VII roster, row AgentCard). Archcheck layer: `support` (rule `support-packages` in `architecture.config.ts`).

Pinned behaviours:
- Per-personality isolation of allowlist, peer and nonce state: `src/__tests__/isolation.test.ts`.
- Token revocation re-checked on every request: `src/__tests__/revocation.test.ts`.
- Self-loop calls refused unless `allowSelfLoop` is set: `src/__tests__/self-loop.test.ts`.

## Testing

```
pnpm vitest run packages/a2a
```

Pinning tests:
- `src/__tests__/isolation.test.ts`: trust state is per personality.
- `src/__tests__/revocation.test.ts`: disabling a peer or rotating its `tokenRef` kills an unexpired token.
- `src/__tests__/self-loop.test.ts`: calling your own agent is refused by default.
- `src/__tests__/auth.test.ts`, `src/__tests__/rpc.test.ts`, `src/__tests__/well-known.test.ts`: the handshake, RPC and card endpoints.
- `src/__tests__/sqlite-task-store.test.ts`: the SQLite task store.
