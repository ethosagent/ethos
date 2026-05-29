import { createServer, type Server } from 'node:http';
import { URL } from 'node:url';

export class LocalOAuthServer {
  private server: Server | null = null;

  async listen(): Promise<{
    port: number;
    waitForCallback(): Promise<Record<string, string>>;
  }> {
    const port = 49152 + Math.floor(Math.random() * (65535 - 49152));
    let resolveCallback: ((params: Record<string, string>) => void) | null = null;

    const callbackPromise = new Promise<Record<string, string>>((resolve) => {
      resolveCallback = resolve;
    });

    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (url.pathname === '/callback') {
        const params: Record<string, string> = {};
        url.searchParams.forEach((value, key) => {
          params[key] = value;
        });
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body><h2>Authentication successful</h2><p>You can close this tab.</p></body></html>',
        );
        if (resolveCallback) resolveCallback(params);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      if (this.server) this.server.listen(port, '127.0.0.1', () => resolve());
    });

    return { port, waitForCallback: () => callbackPromise };
  }

  close(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
