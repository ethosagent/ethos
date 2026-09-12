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
   */
  serverFactory: () => Server | Promise<Server>;
  logger: McpLogger;
  /** Extra `Host` header values to accept, beyond the loopback names. */
  allowedHosts?: string[];
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
 * Refuses a non-loopback bind: this server is unauthenticated and full-trust,
 * so there is no safe non-loopback story until auth ships.
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

  const forbidden = (res: ServerResponse): void => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid Host header' },
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
        forbidden(res);
        return;
      }

      const sessionId = req.headers['mcp-session-id'];
      const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
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
      const server = await opts.serverFactory();
      sessions.set(id, { transport, server });
      // `server.close()` closes the transport, which fires `onclose` again —
      // without the latch that is infinite recursion, not a double close.
      let closed = false;
      transport.onclose = () => {
        if (closed) return;
        closed = true;
        sessions.delete(id);
        void server.close().catch(() => {});
      };
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
