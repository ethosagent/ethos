import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { closeListener, listenWithFallback } from '../serve-listen';

// F06 follow-up (live smoke, 2026-09-11) — `ethos serve` never exited on
// SIGTERM while a browser tab was open: every SPA tab holds `/sse/system`, and
// `server.close()` waits for every open connection, so the shutdown awaited it
// forever and the runtime disposal behind it never ran (SIGKILL after 30 s,
// every -wal file left behind). `closeListener` is what both serve branches
// now call. Real server, real open SSE request.

/** An app whose one route is an SSE stream that never ends. */
const sseApp = {
  fetch: () =>
    new Response(new ReadableStream({ start() {} }), {
      headers: { 'content-type': 'text/event-stream' },
    }),
};

/** Open a streaming request and resolve once its headers arrived. */
function openStream(port: number): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/sse/system' }, (res) => {
      res.on('data', () => {});
      res.on('error', () => {});
      resolve(() => req.destroy());
    });
    req.on('error', () => {});
    req.once('error', reject);
    req.end();
  });
}

/** Bind on an OS-assigned port and report the port actually bound. */
async function listen() {
  const { server } = await listenWithFallback(sseApp, 0, 1);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return { server, port: addr.port };
}

function within(ms: number, p: Promise<void>): Promise<'closed' | 'timed out'> {
  return Promise.race([
    p.then(() => 'closed' as const),
    new Promise<'timed out'>((r) => setTimeout(() => r('timed out'), ms)),
  ]);
}

describe('closeListener (F06)', () => {
  it('a plain server.close() waits on an open SSE stream — the bug', async () => {
    const { server, port } = await listen();
    const drop = await openStream(port);
    const plain = new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await within(300, plain)).toBe('timed out');
    drop();
    await plain;
  });

  it('closes promptly with an SSE stream still open', async () => {
    const { server, port } = await listen();
    await openStream(port);
    const started = Date.now();
    expect(await within(2000, closeListener(server))).toBe('closed');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('closes an idle server too', async () => {
    const { server } = await listen();
    expect(await within(2000, closeListener(server))).toBe('closed');
  });
});
