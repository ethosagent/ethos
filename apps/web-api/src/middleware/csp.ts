import { randomBytes } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

// Content-Security-Policy for every response this app produces (S2, plan
// openclaw-2026.9.6-gaps). Registered first in `createRoutes`
// (routes/index.ts), so it wraps every route, error envelope included.
//
// Three policies, chosen by who built the response:
//
//  • Strict (`strictPolicy`) — the default. API responses (JSON, SSE, file
//    downloads) and the server-rendered `/oauth/callback` page. Scripts run
//    only from this origin or with this response's nonce; the page cannot be
//    framed. A handler that emits an inline script reads the nonce with
//    `c.get('cspNonce')` — `/oauth/callback` is the only one.
//
//  • SPA shell (`SPA_SHELL_CSP`) — set by the static handler
//    (routes/static.ts) on the built `apps/web/dist` files. Framing only. The
//    SPA is NOT under a script/style policy because it cannot be without
//    breaking: `apps/web/index.html` carries an inline bootstrap script, antd
//    injects runtime <style> elements, and chat/dashboard/document/canvas
//    previews are `srcdoc` iframes whose inline scripts inherit the parent's
//    policy (HtmlBlock, DashboardPanelShell, DocumentPreviewBody, CanvasBlock).
//    The desktop shell layers its own policy over every response
//    (`setupSpaCsp` in apps/desktop/src/main/index.ts). Pinned by the
//    'SPA shell under the policy' cases in
//    ../__tests__/routes/oauth-callback-xss.test.ts.
//
//  • API reference (`OPENAPI_DOCS_CSP`) — set by the `/openapi/` route
//    (routes/openapi.ts) on the Scalar docs page only: its CDN script by exact
//    URL and its constant inline bootstrap by hash. Pinned by
//    ../__tests__/routes/openapi.test.ts.
//
// A response that already carries a policy keeps it — that is how the static
// handler's shell policy and the docs page's policy survive this middleware.

export const SPA_SHELL_CSP = "frame-ancestors 'none'";

function strictPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function cspMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const nonce = randomBytes(16).toString('base64');
    c.set('cspNonce', nonce);
    await next();
    if (c.res.headers.has('content-security-policy')) return;
    c.res.headers.set('content-security-policy', strictPolicy(nonce));
  };
}

declare module 'hono' {
  interface ContextVariableMap {
    cspNonce: string;
  }
}
