import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface LoopbackServerOptions {
  port?: number;
  path?: string;
  timeoutMs?: number;
}

export interface LoopbackServerResult {
  port: number;
  redirectUri: string;
  result: Promise<{ code: string; state: string }>;
  close: () => void;
}

export async function startLoopbackServer(
  opts?: LoopbackServerOptions,
): Promise<LoopbackServerResult> {
  const callbackPath = opts?.path ?? '/oauth/callback';
  const listenPort = opts?.port ?? 0;
  const timeoutMs = opts?.timeoutMs ?? 120_000;

  return new Promise((resolveServer, rejectServer) => {
    let settled = false;
    let resolveResult: (result: { code: string; state: string }) => void;
    let rejectResult: (err: Error) => void;

    const resultPromise = new Promise<{ code: string; state: string }>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (settled) {
        res.writeHead(400);
        res.end('Already handled');
        return;
      }

      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (url.pathname !== callbackPath) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        settled = true;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body><h1>Authorization failed</h1><p>You may close this tab.</p></body></html>',
        );
        rejectResult(new Error(`OAuth error: ${error}`));
        closeServer();
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400);
        res.end('Missing code parameter');
        return;
      }

      const state = url.searchParams.get('state');
      if (!state) {
        res.writeHead(400);
        res.end('Missing state parameter');
        return;
      }

      settled = true;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<html><body><h1>Authorization successful</h1><p>You may close this tab.</p></body></html>',
      );
      resolveResult({ code, state });
      closeServer();
    });

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        rejectResult(new Error(`OAuth callback timed out after ${timeoutMs}ms`));
        closeServer();
      }
    }, timeoutMs);

    function closeServer(): void {
      clearTimeout(timeout);
      server.close();
    }

    server.listen(listenPort, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        rejectServer(new Error('Failed to bind callback server'));
        return;
      }

      resolveServer({
        port: addr.port,
        redirectUri: `http://127.0.0.1:${addr.port}${callbackPath}`,
        result: resultPromise,
        close: closeServer,
      });
    });

    server.on('error', (err) => {
      rejectServer(err);
    });
  });
}
