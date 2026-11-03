# @ethosagent/web-api

## Purpose

The HTTP backend for the web and desktop clients, built on Hono and oRPC. `createWebApi` assembles services, repositories, middleware and routes into one Hono app; `ethos serve` is what binds it to a port. It serves `/rpc`, `/sse`, `/openapi`, `/healthz`, an OpenAI-compatible surface, WebSocket voice and browser-takeover sockets, and the built SPA.

## Public surface

This is an app (private; main entry `src/index.ts`; script `build` runs tsup). Main entry points (plus more, see `src/index.ts`):

| Export | Kind | One line |
|---|---|---|
| `createWebApi` | function | Builds the Hono app and its services from `CreateWebApiOptions`. |
| `CreateWebApiOptions` | interface | Everything the host passes in. |
| `CreateWebApiResult` | interface | The Hono `app`, the `chatService` and a system event bus. |
| `ChatService` | class | Chat turns and streaming. |
| `TeamLoopRegistry` | class | Per-team loop handles. |
| `createCookieVerifier` | function | Builds a `CookieVerifier` for session cookies. |
| `WebAdminRepository` | class | Admin credential storage. |
| `WebSessionStore` | class | Web session cookies. |
| `WebTokenRepository` | class | Web tokens. |
| `IdempotencyStore` | class | Idempotency keys for writes. |
| `SatelliteRegistry` | class | Voice satellite registry. |
| `createSatelliteSocket` | function | Satellite WebSocket handler. |
| `setWhatsAppQr` | function | Publishes the WhatsApp pairing QR. |
| `RouteModule` | type | Shape of an extra route module mounted by `basePath`. |

Routes are mounted in `src/routes/index.ts` (`/rpc`, `/sse`, `/auth/codex`, `/openapi`, `/cron`, `/setup/whatsapp`, `/oauth/callback`, `/healthz`, `/metrics`). Procedures live in `src/rpc/*.ts`.

## Seam

Layer: apps. `apps/web-api/src/index.ts` is an `app-entry` module (`app-entry-modules-compose`); `apps/web-api/src/rpc/**` is the `web-api-rpc` layer under archcheck rule `web-api-rpc-is-thin` (rpc handlers validate input, call one service method, return its result; data access belongs in repositories or services). Law 5 is enforced by `l5-apps-through-wiring`. `src/__tests__/layering.test.ts` additionally greps rpc files for forbidden package and `node:fs` imports.

## Testing

```
pnpm vitest run apps/web-api
```

Pinning tests (`src/__tests__/`):

- `layering.test.ts`: rpc handlers import no repository-owned packages or `node:fs`.
- `web-api-dispose.test.ts`: `createWebApi` disposes what it starts and nothing it borrows.
- `vite-proxy-origin.test.ts`: the Vite dev proxy keeps Host equal to Origin for CSRF.
- `middleware/csrf.test.ts`: CSRF origin acceptance.
- `middleware/scope-map-drift.test.ts`: every RPC method in a scoped namespace has an explicit scope entry.
- `middleware/bearer-auth.test.ts`, `middleware/rate-limit.test.ts`: auth and rate limiting.
- `routes/*.test.ts`: route behaviour (auth, healthz, metrics, documents, cron, openai).
