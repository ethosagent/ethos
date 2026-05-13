---
title: "Service-layer HTTP coupling audit"
description: "Findings from the Phase 0 service-layer audit — identifies HTTP-coupled logic in web-api services."
kind: reference
audience: developer
slug: service-coupling-audit
updated: 2026-05-13
---

## Summary

The service layer is overwhelmingly clean. None of the 18 service files import from `hono`, access `Context`/`c.req`/`c.res`, or use HTTP status codes as logic gates. The only coupling worth tracking is the `SseEvent` wire-format type used by `ChatService` and the SSE-oriented `SessionStreamBuffer` it depends on, both of which name SSE in their types but are structurally transport-agnostic (discriminated union + generic ring buffer). A future in-process transport can call every service without an HTTP request in scope.

## Findings

| File | Finding | Classification |
|---|---|---|
| `services/api-keys.service.ts` | No HTTP coupling | clean |
| `services/approval-hook.ts` | No HTTP coupling | clean |
| `services/approvals.service.ts` | No HTTP coupling; uses `EventEmitter` for in-process pub/sub, not SSE directly | clean |
| `services/chat.service.ts:10` | Imports `SseEvent` from `@ethosagent/web-contracts` — a Zod discriminated union named after SSE but structurally a plain data type | cheap fix (v1) |
| `services/chat.service.ts:5-6` | Imports `BufferedEvent` and `SessionStreamBuffer` from `@ethosagent/agent-bridge` — a generic `<E>` ring buffer designed for SSE replay but usable by any transport | cheap fix (v1) |
| `services/chat.service.ts:122-157` | `subscribe()` API shape (sinceSeq + callback + unsubscribe handle) mirrors SSE reconnect semantics (`Last-Event-ID` replay) but does not touch any HTTP object | cheap fix (v1) |
| `services/completions.service.ts` | No HTTP coupling; `X-Ethos-Session` header is read by the route layer and passed in as `sessionKeyOverride: string` | clean |
| `services/config.service.ts` | No HTTP coupling | clean |
| `services/cron.service.ts` | No HTTP coupling | clean |
| `services/evolver.service.ts` | No HTTP coupling | clean |
| `services/kanban.service.ts` | No HTTP coupling | clean |
| `services/lab.service.ts` | No HTTP coupling | clean |
| `services/memory.service.ts` | No HTTP coupling | clean |
| `services/mesh.service.ts` | No HTTP coupling | clean |
| `services/onboarding.service.ts` | No HTTP coupling; uses injected `fetchFn` for outbound provider validation calls (not request/response objects) | clean |
| `services/personalities.service.ts` | No HTTP coupling | clean |
| `services/platforms.service.ts` | No HTTP coupling | clean |
| `services/plugins.service.ts` | No HTTP coupling | clean |
| `services/sessions.service.ts` | No HTTP coupling | clean |
| `services/skills.service.ts` | No HTTP coupling | clean |

## Classification key

- **clean** — no HTTP coupling found
- **cheap fix (v1)** — can be factored out in <30 min
- **v1.1 follow-up** — requires deeper refactoring, tracked for next release

## Details

### `ChatService` — SSE-flavored type names (cheap fix)

`ChatService` is the only service with any coupling signal, and it is mild. Three observations:

1. **`SseEvent` type** (line 10): The imported type is a Zod-inferred discriminated union (`text_delta | tool_start | done | ...`). It carries no HTTP semantics — no headers, no status codes, no stream objects. The name `SseEvent` reflects the current transport, not a structural dependency. Renaming it to `StreamEvent` or `WireEvent` and re-exporting under the old name is a backward-compatible <10 min fix.

2. **`SessionStreamBuffer<SseEvent>`** (constructor option, line 6): This is a generic ring buffer (`SessionStreamBuffer<E>`) parameterized with `SseEvent`. The buffer itself is transport-agnostic — it manages append/replay/reap with monotonic sequence numbers. An in-process transport could subscribe to the same buffer and read `BufferedEvent<SseEvent>` objects without any HTTP machinery. No code change needed to support a second consumer; at most the type parameter name could be generalized.

3. **`subscribe()` method** (lines 132-157): The signature `subscribe(sessionId, sinceSeq, onEvent) => unsubscribe` is a push-subscription pattern that happens to map 1:1 to SSE reconnect (`Last-Event-ID` replay + live tail). An in-process caller can use it identically — pass `sinceSeq: 0`, receive all events via the callback, call the returned function to unsubscribe. No HTTP objects flow through this API.

**Verdict**: `ChatService` is callable without an HTTP request today. The SSE naming is cosmetic, not structural. A v1 rename pass would remove the naming ambiguity so future readers do not mistake it for real coupling.

### RPC handlers — verified clean

All 19 files in `apps/web-api/src/rpc/` import only from `./context` (which provides the oRPC `os` builder) and delegate to service methods. No handler imports from `hono`, accesses `c.req`/`c.res`, or touches HTTP primitives. The oRPC layer handles serialization/deserialization; handlers receive typed `input` and return typed output.

### SSE route — coupling is correctly contained

`apps/web-api/src/routes/sse.ts` is the only file that imports from `hono` and `hono/streaming`. It reads `c.req.param('id')` and `c.req.header('Last-Event-ID')`, then delegates to `ChatService.subscribe()`. This is the expected boundary — the route is the HTTP adapter; the service is transport-free.

### `rpc/context.ts` — injection container, no HTTP types

The `RpcContext` interface holds typed service references. It imports from `@orpc/server` (for the `implement` builder) but does not import or expose any HTTP types. Services are injected by `createWebApi` in `index.ts`.

### `createWebApi` (index.ts) — Hono is imported but only for the return type

`index.ts` imports `type { Hono } from 'hono'` for the `CreateWebApiResult.app` return type. All service construction is pure — no HTTP context flows into any service constructor. The Hono app is assembled in `createRoutes`, which is a separate routing layer.
