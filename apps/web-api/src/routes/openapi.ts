import { createHash } from 'node:crypto';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { OpenAPIReferencePlugin } from '@orpc/openapi/plugins';
import { Hono } from 'hono';
import { apiRouter } from '../rpc/router';
import type { ServiceContainer } from './index';

// OpenAPI surface — auto-generated from the existing zod-based contract.
// Three things are mounted here under one handler:
//   • `/openapi/`           — Scalar API reference UI (browseable docs)
//   • `/openapi/spec.json`  — raw OpenAPI 3.1 spec for tooling import
//   • `/openapi/<route>`    — REST-shaped endpoints derived from the contract
//                             (procedures without `.route()` annotations land
//                              under their RPC paths as `POST` with body input)
//
// One zod source of truth (`packages/web-contracts`), three transports:
//   • `RPCHandler`     at `/rpc/*`     — what apps/web uses (compact protocol)
//   • `OpenAPIHandler` at `/openapi/*` — what curl / Postman / docs UI use
//   • SSE              at `/sse/*`     — streaming events (Phase 26.3)
//
// All three share the same router and validate inputs through the same Zod
// schemas, so contract drift is impossible.

// The docs page runs third-party script, so it cannot live under the app-wide
// strict policy (`cspMiddleware`, ../middleware/csp.ts: same-origin or nonced
// scripts only) and carries its own, set on the docs response below. The
// middleware leaves a response that already has a policy alone.
//
// Scalar is loaded from jsDelivr, as the plugin does by default:
// `@scalar/api-reference` is not a dependency of this repo, so there is no local
// bundle to serve. The source expression is the exact script URL (a path
// without a trailing slash matches only that file), not the CDN host.
//
// The bundle runs on this cookie-authenticated API origin, so it is pinned to
// one version and checked by Subresource Integrity: a changed or substituted
// file is refused by the browser, not run. To bump it, change the version in
// `SCALAR_SCRIPT_URL`, then set `SCALAR_SCRIPT_INTEGRITY` to the SHA-384 of the
// exact bytes jsDelivr serves for the new URL:
//   curl -sSL <url> | openssl dgst -sha384 -binary | openssl base64 -A
// and re-check the page in a browser (the CSP below was read off 1.72.1).
//
// The plugin's own template runs an inline bootstrap that embeds the whole spec,
// and the spec's `servers` entry is the request's origin — so its hash changes
// per Host header. `renderScalarDocsHtml` puts the config in an inert JSON data
// block instead (CSP does not apply to a non-script `type`), leaving an inline
// bootstrap whose text never changes, allowed by its fixed hash.
//
// What the bundle needs beyond its own script, read from the bundle itself
// (@scalar/api-reference 1.72.1): it injects <style> elements, only some of them nonced — hence
// `style-src 'unsafe-inline'`; its default fonts come from fonts.scalar.com.
// `connect-src 'self'` keeps "Try it" requests on this origin: Scalar's
// default request proxy (proxy.scalar.com) is refused, so a request carrying
// this API's credentials never goes through a third party. No 'unsafe-eval':
// the bundle's one `Function('')` call is a feature probe inside a try/catch.
// Checked by loading the page under this policy in headless Chromium: it
// renders, its fonts load, and "Try it" requests go to this origin.
const SCALAR_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1';
const SCALAR_SCRIPT_INTEGRITY =
  'sha384-JezfTaoGe2t8F2YRYUQosjM0S21blpE8j3yOUgTEiTKCyLWx9K4lfwjKPd8Dp7WY';
const SCALAR_BOOTSTRAP =
  "Scalar.createApiReference('#app', JSON.parse(document.getElementById('scalar-config').textContent))";
const SCALAR_BOOTSTRAP_HASH = createHash('sha256').update(SCALAR_BOOTSTRAP).digest('base64');

/** The `/openapi/` docs page's Content-Security-Policy. Pinned by
 *  ../__tests__/routes/openapi.test.ts. */
export const OPENAPI_DOCS_CSP = [
  "default-src 'self'",
  `script-src ${SCALAR_SCRIPT_URL} 'sha256-${SCALAR_BOOTSTRAP_HASH}'`,
  "style-src 'unsafe-inline'",
  'font-src https://fonts.scalar.com',
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** JSON that cannot close its <script> element: the plugin's own escaping. */
const jsonForScriptElement = (value: unknown) =>
  JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/'/g, '\\u0027')
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E')
    .replace(/\//g, '\\u002F');

/** The Scalar page, with its config in a data block and a constant bootstrap. */
function renderScalarDocsHtml(
  _specUrl: string,
  title: string,
  head: string,
  scriptUrl: string,
  config: Record<string, unknown> | undefined,
  spec: unknown,
): string {
  const scalarConfig = { content: JSON.stringify(spec), ...config };
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    ${head}
  </head>
  <body>
    <div id="app"></div>
    <script id="scalar-config" type="application/json">${jsonForScriptElement(scalarConfig)}</script>
    <script src="${escapeHtml(scriptUrl)}" integrity="${SCALAR_SCRIPT_INTEGRITY}" crossorigin="anonymous"></script>
    <script>${SCALAR_BOOTSTRAP}</script>
  </body>
</html>
`;
}

export interface OpenApiRoutesOptions {
  services: ServiceContainer;
  /** Title shown in the docs UI tab + heading. */
  docsTitle?: string;
}

export function openapiRoutes(opts: OpenApiRoutesOptions) {
  const handler = new OpenAPIHandler(apiRouter, {
    plugins: [
      new OpenAPIReferencePlugin({
        docsPath: '/',
        specPath: '/spec.json',
        docsProvider: 'scalar',
        docsScriptUrl: SCALAR_SCRIPT_URL,
        renderDocsHtml: renderScalarDocsHtml,
        docsTitle: opts.docsTitle ?? 'Ethos Web API',
        // Generator metadata — surfaces in the docs UI header + spec.json.
        // Lives under `specGenerateOptions` because it's passed through to
        // the OpenAPIGenerator's `generate(...)` call (extends OpenAPI.Document).
        specGenerateOptions: {
          info: {
            title: opts.docsTitle ?? 'Ethos Web API',
            version: '0.1.0',
            description:
              'Auto-generated from the Zod-based oRPC contract in `@ethosagent/web-contracts`. ' +
              'Every procedure validates input through the same Zod schema the typed client uses.',
          },
        },
      }),
    ],
  });

  const app = new Hono();
  app.all('/*', async (c) => {
    const { matched, response } = await handler.handle(c.req.raw, {
      prefix: '/openapi',
      context: opts.services,
    });
    if (matched && response) {
      if (c.req.method === 'GET' && c.req.path.replace(/\/$/, '') === '/openapi') {
        response.headers.set('content-security-policy', OPENAPI_DOCS_CSP);
      }
      return response;
    }
    return c.text('Not Found', 404);
  });
  return app;
}
