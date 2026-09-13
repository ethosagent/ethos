// Streamable-HTTP hosting for an MCP server, one `Server` per session.
//
// Two bugs this module exists to close:
//
//  1. SDK 1.29.0's `Protocol.connect` throws `Already connected to a transport`
//     on a second call, so a single shared `Server` served exactly one HTTP
//     session and every session after it failed to initialize. Each session now
//     gets its own `Server` from `serverFactory`, closed when its transport does.
//  2. A loopback HTTP server with no auth is reachable from any page the user
//     visits via DNS rebinding. `enableDnsRebindingProtection` + `allowedHosts`
//     (the SDK's own `validateRequestHeaders`, which answers 403) pins the Host
//     header to the loopback names on the bound port.
//
// Shared on purpose: the global operator console and the per-personality MCP
// export both host over HTTP this way.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpLogger } from './logger';

/**
 * What {@link ServeMcpHttpOptions.authorize} answers for ONE request.
 *
 * A refusal carries the HTTP status and a short code the host wants written —
 * the helper renders it as a JSON-RPC error body and never learns WHY (whose
 * key, which scope, which personality): that is the host's business, and
 * keeping it there is what stops this transport growing a second auth model
 * beside the export server's.
 */
export type McpHttpAuthDecision = { ok: true } | { ok: false; status: number; message: string };

export interface ServeMcpHttpOptions {
  /** TCP port. `0` binds an ephemeral port — read the real one off the handle. */
  port: number;
  /** Loopback only. Defaults to `127.0.0.1`. */
  host?: string;
  /** Request path for the MCP endpoint. Defaults to `/mcp`. */
  path?: string;
  /**
   * Builds the `Server` for ONE session. Called once per new session, never
   * shared — see bug 1 above. Register handlers on the returned instance.
   *
   * It receives the request that OPENED the session so a host whose handlers
   * are per-credential (the personality export binds its session key to the
   * caller's bearer key) can read it off the same request `authorize` just
   * accepted, instead of guessing from a shared slot two concurrent
   * initializes would race over.
   */
  serverFactory: (ctx: { req: IncomingMessage }) => Server | Promise<Server>;
  logger: McpLogger;
  /** Extra `Host` header values to accept, beyond the loopback names. */
  allowedHosts?: string[];
  /**
   * Per-REQUEST authorization, run after the Host check and before any session
   * lookup or `Server` allocation. Absent → the endpoint is unauthenticated,
   * which is what the global operator console is (M-D14).
   *
   * Every request, not just `initialize`: a bearer key that is revoked mid
   * session must stop working on the caller's next call, and an MCP session is
   * a long-lived thing that would otherwise outlive its own credential
   * (`export-server.ts`, M-T6). `sessionId` is the `Mcp-Session-Id` header as
   * sent — `undefined` on the initialize request — so a host that binds a
   * session to a credential can check the binding here too.
   */
  authorize?: (ctx: {
    req: IncomingMessage;
    sessionId: string | undefined;
  }) => Promise<McpHttpAuthDecision> | McpHttpAuthDecision;
  /**
   * Called once with the id of each newly created session, after `authorize`
   * accepted the request that created it. The hook for binding a session to
   * whatever credential opened it.
   */
  onSessionOpened?: (sessionId: string, req: IncomingMessage) => void;
  /** Called when a session's transport closes — release the binding. */
  onSessionClosed?: (sessionId: string) => void;
}

export interface McpHttpHandle {
  /** The port actually bound (resolves `port: 0`). */
  port: number;
  host: string;
  /** Exact `Host` header values accepted; everything else gets 403. */
  allowedHosts: readonly string[];
  /** Idempotent. Closes every live session, then the listener. */
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Start an MCP Streamable-HTTP listener.
 *
 * Refuses a non-loopback bind. The operator console that first used this helper
 * is unauthenticated and full-trust, so it had no safe non-loopback story at
 * all; the personality export supplies an {@link ServeMcpHttpOptions.authorize}
 * hook, but a bearer key over plaintext HTTP is not one either — a remote
 * caller needs the operator's own TLS-terminating proxy in front (M-D15).
 */
export async function serveMcpHttp(opts: ServeMcpHttpOptions): Promise<McpHttpHandle> {
  const host = opts.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      'MCP HTTP server only binds to loopback (127.0.0.1). Non-loopback binds are not supported until an auth story ships.',
    );
  }
  const path = opts.path ?? '/mcp';

  // Filled once the port is known (`port: 0` binds ephemeral). Mutated IN PLACE
  // so the transports that captured this array see the final values.
  const allowedHosts: string[] = [];

  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();

  const refuse = (res: ServerResponse, status: number, message: string): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message },
        id: null,
      }),
    );
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === path) {
      // Checked here as well as inside the transport: without it, a rebound
      // request would allocate a Server and a transport before the SDK's own
      // `validateRequestHeaders` rejected it.
      if (!allowedHosts.includes(req.headers.host ?? '')) {
        opts.logger.warn('mcp_http_host_rejected', { host: req.headers.host ?? null });
        refuse(res, 403, 'Invalid Host header');
        return;
      }

      const sessionId = req.headers['mcp-session-id'];
      const presentedSession = typeof sessionId === 'string' ? sessionId : undefined;

      if (opts.authorize) {
        const decision = await opts.authorize({ req, sessionId: presentedSession });
        if (!decision.ok) {
          refuse(res, decision.status, decision.message);
          return;
        }
      }

      const existing = presentedSession ? sessions.get(presentedSession) : undefined;
      if (existing) {
        await existing.transport.handleRequest(req, res);
        return;
      }

      const id = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => id,
        enableDnsRebindingProtection: true,
        allowedHosts,
      });
      const server = await opts.serverFactory({ req });
      sessions.set(id, { transport, server });
      // `server.close()` closes the transport, which fires `onclose` again —
      // without the latch that is infinite recursion, not a double close.
      let closed = false;
      transport.onclose = () => {
        if (closed) return;
        closed = true;
        sessions.delete(id);
        opts.onSessionClosed?.(id);
        void server.close().catch(() => {});
      };
      opts.onSessionOpened?.(id, req);
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  };

  const httpServer = createHttpServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      opts.logger.error('mcp_http_request_failed', { error: message });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (err: Error): void => reject(err);
    httpServer.once('error', onListenError);
    httpServer.listen(opts.port, host, () => {
      httpServer.removeListener('error', onListenError);
      resolve();
    });
  });
  httpServer.on('error', (err) => {
    opts.logger.error('mcp_http_server_error', { error: err.message });
  });

  const address = httpServer.address();
  const boundPort = typeof address === 'object' && address ? address.port : opts.port;
  allowedHosts.push(`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`);
  if (opts.allowedHosts) allowedHosts.push(...opts.allowedHosts);

  opts.logger.info('mcp_server_started', {
    transport: 'streamable-http',
    host,
    port: boundPort,
    path,
  });

  let closing: Promise<void> | null = null;
  return {
    port: boundPort,
    host,
    allowedHosts,
    close(): Promise<void> {
      closing ??= (async () => {
        for (const { server } of [...sessions.values()]) {
          // Closes its transport too (`Protocol.close`).
          await server.close().catch(() => {});
        }
        sessions.clear();
        const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
        // An idle keep-alive socket (or a hung SSE stream) would otherwise hold
        // `close()` open forever.
        httpServer.closeAllConnections();
        await closed;
      })();
      return closing;
    },
  };
}
