# @ethosagent/sdk

## Purpose

Typed TypeScript client for the Ethos control-plane API. It provides RPC calls validated against the shared contract (`@ethosagent/web-contracts`) and an SSE streaming client for real-time agent events.

```bash
pnpm add @ethosagent/sdk
```

## Public surface

From `src/index.ts`.

| Export | Kind | One line |
|---|---|---|
| `EthosClient` | class | RPC client; all contract namespaces are on `client.rpc`. |
| `createEthosClient` | function | Factory building an `EthosClient` from `CreateEthosClientOptions`. |
| `EventStream` | function | Opens an SSE subscription to a session's events and auto-reconnects. |
| `EthosError` | class | Error type carrying an `EthosErrorCode`. |
| `HttpDispatcher` | class | Default HTTP `Dispatcher` implementation. |
| `Dispatcher` | type | Transport seam the client sends requests through. |
| `Contract`, `SseEvent`, `ApiKeyScope`, `ApiKeyMetadata` | type | Re-exported from `@ethosagent/web-contracts`. |

Option and subscription types (`CreateEthosClientOptions`, `EventStreamOptions`, `EventStreamSubscription`, `HttpDispatcherOptions`) are also exported from `src/index.ts`.

## Seam

Consumes the RPC contract in `@ethosagent/web-contracts`; archcheck layer `support` (rule `support-packages` in `architecture.config.ts`), which may import only contracts, the security kernel and vendored shims. Its behaviour is pinned by `src/__tests__/client.test.ts` and `src/__tests__/stream.test.ts`.

## More

- [docs/quick-start.md](./docs/quick-start.md) -- install, first message, stream the response.
- [docs/client.md](./docs/client.md) -- `EthosClient` options, RPC usage, stable and experimental namespaces.
- [docs/event-stream.md](./docs/event-stream.md) -- `EventStream`, event types, cookie-auth mode.
- [docs/exports.md](./docs/exports.md) -- the previous export listing and reference-site links.

## Testing

```
pnpm vitest run packages/sdk
```

Pinning tests: `src/__tests__/client.test.ts`, `src/__tests__/stream.test.ts`.
