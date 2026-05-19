import { isEthosError } from '@ethosagent/types';
import { ORPCError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { statusFor } from '../middleware/error-envelope';
import { apiRouter } from '../rpc/router';
import type { ServiceContainer } from './index';

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

export interface RpcRoutesOptions {
  services: ServiceContainer;
}

export function rpcRoutes(opts: RpcRoutesOptions) {
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

    // Thread the cookie value into the service context so McpService can
    // use it as the CSRF binding key.
    const context: ServiceContainer = mcpPending
      ? Object.create(opts.services, {
          _mcpPendingState: { value: mcpPending, enumerable: false },
        })
      : opts.services;

    const { matched, response } = await handler.handle(c.req.raw, {
      prefix: '/rpc',
      context,
    });

    if (!matched || !response) return c.text('Not Found', 404);

    const path = new URL(c.req.url).pathname;

    // mcp.start — set cookie with the state value returned by the handler.
    if (path === '/rpc/mcp.start' && response.ok) {
      try {
        const cloned = response.clone();
        const body = await cloned.json();
        const state: unknown = body?.state;
        if (body?.ok === true && typeof state === 'string') {
          const headers = new Headers(response.headers);
          const secure = c.req.url.startsWith('https');
          headers.append(
            'Set-Cookie',
            [
              `${MCP_PENDING_COOKIE}=${state}`,
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

    // mcp.complete or mcp.cancel — clear the cookie after the handler runs.
    if (path === '/rpc/mcp.complete' || path === '/rpc/mcp.cancel') {
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
