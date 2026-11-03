# @ethosagent/web

## Purpose

The Ethos browser client: a React 19 single-page app (Vite, Ant Design, React Router, TanStack Query). It talks to `apps/web-api` over `/rpc`, `/sse` and WebSocket paths, and `apps/web-api` serves its build in production runs of `ethos serve`.

## Public surface

This is a private app (no library exports, no binary). Entry points:

| Export | Kind | One line |
|---|---|---|
| `main.tsx` | entry | SPA bootstrap (`src/main.tsx`). |
| `App` | component | Router and shell; routes include `/chat`, `/sessions`, `/skills`, `/memory`, `/personalities`, `/settings`, `/mcp`, `/dashboards`, `/onboarding` (`src/App.tsx`). |

Scripts: `dev` (Vite at :5173 with proxy to the API on :3000), `build` (writes `apps/web/dist/`), `preview`, `typecheck`. Feature code lives in `src/features/*` and `src/pages/*`.

## Seam

Layer: not seen by archcheck. `architecture.config.ts` states apps/web is excluded from the root tsconfig archcheck reads, so no layer rule applies. The dev proxy must keep `changeOrigin: false` so the API's CSRF check sees a matching Origin and Host; `apps/web-api/src/__tests__/vite-proxy-origin.test.ts` fails if it does not (see the header of `vite.config.ts`). Pure UI decisions follow `.claude/rules/ui-design.md` and DESIGN.md.

## Testing

```
pnpm vitest run apps/web
```

Pinning tests (`src/__tests__/`):

- `rpc.test.ts`: the RPC client module.
- `sse.test.ts`, `sse-connection-state.test.ts`: the EventSource wrapper and connection state.
- `design-tokens.test.ts`: design-token usage.

Page tests under `src/pages/__tests__` are `.test.ts` files only; the root vitest glob does not run `.tsx` tests.
