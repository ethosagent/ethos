import { createServer } from 'node:http';
import { URL } from 'node:url';

export class LocalOAuthServer {
  server = null;

  async listen() {
    const port = 49152 + Math.floor(Math.random() * (65535 - 49152));
    let resolveCallback = null;

    const callbackPromise = new Promise((resolve) => {
      resolveCallback = resolve;
    });

    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (url.pathname === '/callback') {
        const params = {};
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

    await new Promise((resolve) => {
      if (this.server) this.server.listen(port, '127.0.0.1', () => resolve());
    });

    return { port, waitForCallback: () => callbackPromise };
  }

  close() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
