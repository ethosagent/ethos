---
title: "Why does the SDK hide its transport behind a seam?"
description: "The SDK hides its transport behind a seam — RPC calls flow through RPCLink today, but the same surface can dispatch in-process when a future link lands."
kind: explanation
audience: developer
slug: transport-seam
updated: 2026-05-13
---

## Context

`EthosClient` in `packages/sdk/src/client.ts` exposes a typed RPC surface: `client.rpc.sessions.list(...)`, `client.rpc.chat.send(...)`, and so on. Internally, every call flows through a single `RPCLink` from `@orpc/client/fetch`, which serializes the request as JSON, sends it over HTTP to `${baseUrl}/rpc`, and deserializes the response.

The SDK's public API does not mention HTTP. Callers see method calls with typed input/output — the transport is an implementation detail. This separation is the transport seam.

## How RPCLink works today

`RPCLink` is constructed with a URL and optional headers or fetch override:

```typescript
const link = new RPCLink({
  url: `${base}/rpc`,
  ...(this.apiKey
    ? { headers: () => ({ Authorization: `Bearer ${this.apiKey}` }) }
    : {
        fetch: (input, init) =>
          fetchFn(input, { ...init, credentials: 'include' }),
      }),
});
```

Two auth paths branch at construction time. API key auth passes the key as a `Bearer` header on every request. Cookie auth passes `credentials: 'include'` so the browser sends the `ethos_auth` cookie. The rest of the SDK does not know which path was taken — it calls `this.rpc.sessions.list({})` either way.

The SSE event stream (`packages/sdk/src/stream.ts`) uses the same branching: API key goes in an `Authorization` header; cookie auth uses `credentials: 'include'`. The two transport surfaces (RPC and SSE) share the auth model but not the transport mechanism — RPC is request/response, SSE is a long-lived stream.

## Method-shape discipline

The design principle behind the transport seam is: **design against in-process first, then let HTTP serialize**.

Every procedure in the contract takes a plain object as input and returns a plain object as output. No procedure depends on HTTP-specific concepts — no path parameters, no query strings, no multipart form data, no streaming request bodies. The input is `{ id: string }` or `{ store: 'memory', content: string }`, not `PUT /sessions/:id` with a body.

This discipline means every procedure is callable as a plain function: `service.sessions.get({ id: '...' })`. HTTP is just one way to invoke it. The server already works this way internally — the oRPC server layer deserializes the HTTP request into the input object, calls the service function, and serializes the output back to HTTP. The service functions themselves are transport-agnostic.

The same discipline applies to the contract schemas. Zod schemas in `router.ts` define shapes that are JSON-serializable by construction. No `Date` objects (use ISO-8601 strings), no `Buffer` (use base64 strings or separate upload endpoints), no `Map` or `Set` (use records and arrays). This is not an accident — it is a prerequisite for transport flexibility.

## Why the seam matters

Three practical consequences:

**Testing without a server.** A test that exercises SDK behavior does not need a running HTTP server. A mock or stub that implements the same method signatures works. The SDK's `rpc` property is typed as `ContractRouterClient<Contract>` — any object satisfying that interface is valid, regardless of how it dispatches.

**Future in-process transport.** An Electron app or a VS Code extension that embeds the Ethos agent in the same process should not pay the cost of HTTP serialization/deserialization for every RPC call. The seam is where an `InProcessLink` would plug in — same `createORPCClient(link)` call, different link implementation that dispatches directly to the service layer.

**Transport migration without API changes.** If oRPC's `RPCLink` is replaced (by a WebSocket link, a gRPC link, or something that does not exist yet), SDK consumers see no change. Their code calls `client.rpc.sessions.list({})`. The link is internal.

## The EventStream surface

`EventStream` in `packages/sdk/src/stream.ts` is the second transport surface. It connects to `/sse/sessions/:sessionId` and yields parsed `SseEvent` objects via a callback. Unlike RPC, it is not mediated by oRPC — it is a raw `fetch` with manual SSE parsing (line-delimited `id:` / `data:` / blank-line protocol).

The EventStream shares the transport seam's design intent — the public API is `onEvent: (event: SseEvent, seq: number) => void`, not "parse this HTTP stream" — but it does not share the link abstraction. An in-process transport for events would need a separate mechanism: an `EventEmitter`, an `AsyncIterator`, or a direct callback from the agent loop's `run()` generator.

This asymmetry is acknowledged. The RPC seam is clean; the SSE seam is adequate but less abstract. Unifying them under a single transport interface is a v1.1 concern.

## v1.1 direction: InProcessDispatcher

The planned `InProcessDispatcher` would:

1. Accept the same contract-typed method calls as `RPCLink`.
2. Dispatch directly to the service layer functions without HTTP serialization.
3. Handle auth via a constructor-injected identity rather than cookies or bearer tokens.
4. Route events (the SSE equivalent) via a synchronous callback or `AsyncIterable`, matching the `EventStream` callback shape.

The dispatcher does not exist yet. The architecture supports it because:

- The contract is transport-agnostic (plain objects in, plain objects out).
- The service layer is already a set of plain functions called by the oRPC server.
- The `createORPCClient` API accepts any link implementation.
- The `EventStream` callback shape (`onEvent`) is not HTTP-specific.

When `InProcessDispatcher` lands, the SDK constructor will accept either a `baseUrl` (HTTP transport) or a `dispatcher` (in-process transport). The `rpc` property and `EventStream` function will work identically in both modes.

## Practical guidance for dashboard builders

Build against the method shapes, not the transport. Call `client.rpc.sessions.list({})`, not `fetch('/rpc/sessions/list', ...)`. Use `EventStream({ baseUrl, sessionId, onEvent })`, not raw SSE parsing.

If you follow the SDK's public API, your code will work when the transport changes. If you reach past the SDK and construct HTTP requests directly, you are coupling to a transport that may be replaced.
