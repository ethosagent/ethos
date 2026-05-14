import { describe, expect, it } from 'vitest';
import { EthosMcpServer } from '../server';

// ---------------------------------------------------------------------------
// Minimal stubs for EthosMcpServerConfig dependencies
// ---------------------------------------------------------------------------

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Minimal AgentLoop stub — serveHttp doesn't invoke the loop directly,
// it just wires MCP handlers that reference it.
// biome-ignore lint/suspicious/noExplicitAny: minimal test stub
const stubLoop = {} as any;

// ---------------------------------------------------------------------------
// serveHttp safety tests
// ---------------------------------------------------------------------------

describe('EthosMcpServer.serveHttp', () => {
  it('refuses 0.0.0.0 without bindPublic flag', async () => {
    const server = new EthosMcpServer({
      loop: stubLoop,
      dataDir: '/tmp/ethos-test',
      logger: noopLogger,
    });

    await expect(
      server.serveHttp({ port: 3300, host: '0.0.0.0' }),
    ).rejects.toThrow('Binding to 0.0.0.0 requires --bind-public flag');
  });

  it('refuses 0.0.0.0 with bindPublic=false', async () => {
    const server = new EthosMcpServer({
      loop: stubLoop,
      dataDir: '/tmp/ethos-test',
      logger: noopLogger,
    });

    await expect(
      server.serveHttp({ port: 3300, host: '0.0.0.0', bindPublic: false }),
    ).rejects.toThrow('Binding to 0.0.0.0 requires --bind-public flag');
  });

  it('defaults to loopback when no host specified and bindPublic not set', async () => {
    // We can't fully test the server starts without a real loop,
    // but we can verify it does NOT throw the public-bind error
    // when host is omitted (defaults to 127.0.0.1).
    const server = new EthosMcpServer({
      loop: stubLoop,
      dataDir: '/tmp/ethos-test',
      logger: noopLogger,
    });

    // This will fail with a different error (because stubLoop has no real handlers)
    // or succeed and bind. We just need to confirm it doesn't throw the bind-public error.
    try {
      // Use a random high port to avoid conflicts, and a short timeout
      const promise = server.serveHttp({ port: 0 });
      // Use port 0 to let OS pick — the server will attempt to start.
      // We give it a moment then consider the test passed if no bind-public error.
      await Promise.race([
        promise,
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Should NOT be the bind-public error
      expect(msg).not.toContain('--bind-public');
    }
  });
});
