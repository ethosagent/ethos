import { isEthosError } from '@ethosagent/types';
import { ORPCError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { statusFor } from '../middleware/error-envelope';
import { apiRouter } from '../rpc/router';
import { deriveMcpRequestOrigin } from './rpc-origin';

// Mounts the oRPC handler at `/*` (relative to wherever this sub-app is
// attached — `createWebApi` mounts it under `/rpc`). The handler lifts the
// service container into the procedure context, so each procedure body sees
// a fully-typed `context.sessions`, etc.
//
// Interceptor: services raise `EthosError` with structured codes. oRPC, on
// its own, catches anything that isn't `ORPCError` and renders 500 with a
// generic message — the structured code never reaches the wire. The
// interceptor translates `EthosError → ORPCError`, mirroring the
// `code/status/message` mapping the `error-envelope` middleware applies to
// non-RPC routes.
// ---------------------------------------------------------------------------
// MCP pending-state cookie — CSRF binding for the OAuth install flow.
//
// mcp.start sets an HttpOnly cookie containing the `state` token so that
// mcp.complete / mcp.status / mcp.cancel can verify the browser that
// started the flow is the same one finishing it.
// ---------------------------------------------------------------------------
const MCP_PENDING_COOKIE = 'ethos_mcp_pending';
const MCP_COOKIE_MAX_AGE = 600; // 10 minutes
/**
 * Builds the HTTP path oRPC's RPCHandler routes an `mcp.*` procedure to.
 * oRPC joins nested procedure segments with `/` under the `/rpc` prefix —
 * `rpc.mcp.start()` → `POST /rpc/mcp/start`. This was once hardcoded with a
 * `.` separator, which silently never matched and broke the install wizard.
 * Centralising the separator here means a regression breaks every MCP path
 * at once, which the mcp/cancel route test catches.
 */
export function mcpRpcPath(procedure) {
  return `/rpc/mcp/${procedure}`;
}
export function rpcRoutes(opts) {
  const handler = new RPCHandler(apiRouter, {
    interceptors: [
      async (options) => {
        try {
          return await options.next();
        } catch (err) {
          if (isEthosError(err)) {
            throw new ORPCError(err.code, {
              status: statusFor(err.code),
              message: err.cause,
              data: { action: err.action },
              cause: err,
            });
          }
          throw err;
        }
      },
    ],
  });
  const app = new Hono();
  app.all('/*', async (c) => {
    // Read the pending cookie before the oRPC handler runs.
    // For mcp.status the state comes from the cookie, not the body.
    const mcpPending = getCookie(c, MCP_PENDING_COOKIE);
    // Derive the OAuth callback URL from the inbound request so the MCP
    // install flow registers a redirect_uri that matches whatever
    // host/port the web UI is actually being served on. Returns undefined
    // when the origin can't be trusted (non-loopback, non-private,
    // non-allowlisted); McpService falls back to the constructor default
    // in that case.
    const mcpRequestOrigin = deriveMcpRequestOrigin(c.req.raw, opts.webBaseUrl);
    // Parse the pending cookie: `<state>.<personalityId>`. The cookie was
    // set by mcp.start and carries both values so complete/status can
    // recover the personalityId without trusting the request body.
    let mcpPendingState;
    let mcpPendingPersonalityId;
    if (mcpPending) {
      const dotIdx = mcpPending.indexOf('.');
      if (dotIdx !== -1) {
        mcpPendingState = mcpPending.slice(0, dotIdx);
        mcpPendingPersonalityId = mcpPending.slice(dotIdx + 1);
      } else {
        mcpPendingState = mcpPending;
      }
    }
    // For mcp.start, clone the request so we can read personalityId from
    // the body after the handler consumes the original.
    const path = new URL(c.req.url).pathname;
    let startReqClone;
    if (path === mcpRpcPath('start')) {
      startReqClone = c.req.raw.clone();
    }
    // Thread the cookie value + derived redirect URI into the service
    // context as enumerable own properties. oRPC interceptors spread the
    // context (`{...options.context, ...next.context}`), so prototype-only
    // properties would be lost — every field the handlers read must be
    // own-and-enumerable on the same object. The underscore prefix marks
    // these as framework-internal so namespace code knows not to touch
    // them outside the dedicated helpers in `rpc/mcp.ts`.
    const context =
      mcpPendingState || mcpRequestOrigin || mcpPendingPersonalityId
        ? Object.assign(
            Object.create(null),
            opts.services,
            mcpPendingState ? { _mcpPendingState: mcpPendingState } : {},
            mcpPendingPersonalityId ? { _mcpPendingPersonalityId: mcpPendingPersonalityId } : {},
            mcpRequestOrigin ? { _mcpRequestOrigin: mcpRequestOrigin } : {},
          )
        : opts.services;
    const { matched, response } = await handler.handle(c.req.raw, {
      prefix: '/rpc',
      context,
    });
    if (!matched || !response) return c.text('Not Found', 404);
    // mcp.start — set cookie with `<state>.<personalityId>` so
    // complete/status can recover both from the HttpOnly cookie.
    if (path === mcpRpcPath('start') && response.ok) {
      try {
        const cloned = response.clone();
        const body = await cloned.json();
        const state = body?.state;
        if (body?.ok === true && typeof state === 'string') {
          // Read personalityId from the cloned request body.
          let reqPersonalityId = '';
          if (startReqClone) {
            try {
              const reqBody = await startReqClone.json();
              if (typeof reqBody?.personalityId === 'string') {
                reqPersonalityId = reqBody.personalityId;
              }
            } catch {
              /* best-effort */
            }
          }
          const cookieValue = reqPersonalityId ? `${state}.${reqPersonalityId}` : String(state);
          const headers = new Headers(response.headers);
          const secure = c.req.url.startsWith('https');
          headers.append(
            'Set-Cookie',
            [
              `${MCP_PENDING_COOKIE}=${cookieValue}`,
              'HttpOnly',
              secure ? 'Secure' : '',
              'SameSite=Strict',
              'Path=/rpc',
              `Max-Age=${MCP_COOKIE_MAX_AGE}`,
            ]
              .filter(Boolean)
              .join('; '),
          );
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }
      } catch {
        // If body parsing fails, return the response as-is.
      }
    }
    // mcp.cancel — clear the cookie after the handler runs.
    //
    // The cookie is NOT cleared on mcp.complete: the wizard's mcp.status
    // polling derives the flow `state` from this cookie, and it must keep
    // observing the terminal `connected` state during the install flow's
    // terminal-retention window. Only an explicit mcp.cancel (user aborted)
    // clears it. A stale cookie after a completed flow is harmless — it is
    // HttpOnly, SameSite=Strict, scoped to Path=/rpc, gets overwritten by
    // the next mcp.start, and the server-side flow state self-expires.
    if (path === mcpRpcPath('cancel')) {
      const headers = new Headers(response.headers);
      headers.append(
        'Set-Cookie',
        `${MCP_PENDING_COOKIE}=; HttpOnly; SameSite=Strict; Path=/rpc; Max-Age=0`,
      );
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  });
  return app;
}
