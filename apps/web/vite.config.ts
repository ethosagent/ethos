import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type PluginOption } from 'vite';

// Vite config for the web client. Two run modes:
//
//  • Dev   — `pnpm --filter @ethosagent/web dev` runs Vite at :5173 with the
//            `/rpc`, `/sse`, `/auth`, `/openapi`, `/documents`, `/oauth` and
//            `/api` paths proxied to the ethos-serve API on :3000, the
//            WhatsApp setup event stream (`/setup/whatsapp/`, event-stream
//            requests only; see the entry), plus the
//            two WebSocket paths the SPA opens against `location.host`:
//            `/voice/ws` and `/browser/takeover/ws` (`ws: true`). Every
//            API-bound entry MUST set `changeOrigin: false`, so the API sees
//            `Host: localhost:5173` — the same host:port as the browser's
//            `Origin`. That is load-bearing: the CSRF middleware accepts a
//            localhost Origin only when it equals the request `Host`
//            (`isSameOriginLocalhost` in apps/web-api/src/middleware/csrf.ts,
//            pinned by apps/web-api/src/__tests__/middleware/csrf.test.ts).
//            A plain-string entry means `changeOrigin: true` in Vite, which
//            rewrites Host to :3000 and gets every write refused;
//            apps/web-api/src/__tests__/vite-proxy-origin.test.ts fails on it.
//            The WebSocket entries rely on the same fact: the upgrade Origin
//            check (`originAllowed` in apps/web-api/src/voice/voice-socket.ts)
//            also requires the Origin host:port to equal `Host`. They are keyed
//            on the socket path, not `/voice` or `/browser`, so no SPA route
//            under those prefixes is sent to the API.
//  • Build — `pnpm --filter @ethosagent/web build` writes to `apps/web/dist/`.
//            `apps/web-api`'s static handler serves that directory in
//            production runs of `ethos serve`.
//
// The `@ethosagent/*` aliases mirror the root tsconfig so workspace imports
// resolve to source — same pattern the rest of the monorepo uses (no build
// step in dev).

const root = resolve(__dirname, '../..');

export default defineConfig({
  plugins: [react()] as PluginOption[],
  root: __dirname,
  resolve: {
    alias: {
      '@ethosagent/web-contracts': resolve(root, 'packages/web-contracts/src'),
      '@ethosagent/ui-components': resolve(root, 'packages/ui-components/src'),
      // Contracts. Mostly `import type` here, but the call-treatment
      // derivation is a VALUE the Call Stage calls at render time, and the
      // character sheet calls the same function server-side — one precedence
      // rule, so the alias has to resolve for real, not just for tsc.
      '@ethosagent/types': resolve(root, 'packages/types/src'),
      // The realtime tier's frame mapping, shared with the server-side
      // providers. Carries no transport, so nothing node-only rides along —
      // `packages/voice-realtime-protocol/src/__tests__/browser-safety.test.ts`
      // fails the build if that stops being true.
      '@ethosagent/voice-realtime-protocol': resolve(root, 'packages/voice-realtime-protocol/src'),
    },
    // Vite's default order puts '.js' ahead of '.ts'/'.tsx'. Committed compiled
    // mirrors next to their sources (`packages/ui-components/src/*.js`) once
    // silently shadowed the real `.tsx` in every build — edits to the source
    // were no-ops. Those copies have been removed and `.gitignore` now keeps
    // them out; the order stays as defence against any future stray compile
    // output. TypeScript first also matches what esbuild/tsup already do, so
    // one resolution order holds across bundlers. Same class of bug as f7e920f.
    extensions: ['.mts', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/rpc': { target: 'http://localhost:3000', changeOrigin: false },
      '/sse': {
        target: 'http://localhost:3000',
        changeOrigin: false,
        // SSE keeps the connection open; turn off buffering so events flush.
        ws: false,
      },
      '/auth': { target: 'http://localhost:3000', changeOrigin: false },
      '/openapi': { target: 'http://localhost:3000', changeOrigin: false },
      // OAuth callback — proxy to the API server so the server-side handler
      // runs regardless of whether the DCR redirect_uri points to :5173 or :3000.
      '/oauth': { target: 'http://localhost:3000', changeOrigin: false },
      // Documents download streams bytes over a plain <a download> navigation
      // authenticated by the `SameSite=Strict` `ethos_auth` cookie. It MUST be
      // proxied: an absolute :3000 href from :5173 is cross-site and the
      // browser silently drops the cookie, so the download 401s.
      '/documents': { target: 'http://localhost:3000', changeOrigin: false },
      // Avatar upload/view/delete rides the same `SameSite=Strict`
      // `ethos_auth` cookie as `/documents` above, for the same reason: an
      // absolute :3000 request from :5173 is cross-site and drops the cookie.
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
      // WhatsApp pairing stream. `/setup/whatsapp/:botId` is BOTH a client-side
      // page (App.tsx) and the API's SSE endpoint (apps/web-api/src/routes/
      // setup-whatsapp.ts). Only the `EventSource` request, which sends
      // `Accept: text/event-stream`, goes to the API. Every other request gets
      // its own URL back from `bypass`, and in Vite 6 that means "do not proxy,
      // continue down the middleware chain", which serves the SPA.
      '/setup/whatsapp/': {
        target: 'http://localhost:3000',
        changeOrigin: false,
        bypass: (req) => (req.headers.accept?.includes('text/event-stream') ? undefined : req.url),
      },
      // WebSocket lanes the SPA opens at `${location.host}<path>`
      // (VOICE_SOCKET_PATH and BROWSER_TAKEOVER_SOCKET_PATH in
      // packages/web-contracts). `/satellite/ws` is not here: only the
      // satellite daemon opens it, never the SPA.
      '/voice/ws': { target: 'http://localhost:3000', changeOrigin: false, ws: true },
      '/browser/takeover/ws': { target: 'http://localhost:3000', changeOrigin: false, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
