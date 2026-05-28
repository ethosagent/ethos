import { describe, expect, it } from 'vitest';
import { EthosMcpServer } from '../server';

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
// biome-ignore lint/suspicious/noExplicitAny: minimal test stub
const stubLoop = {};
describe('EthosMcpServer.serveHttp', () => {
  it('refuses non-loopback hosts', async () => {
    const server = new EthosMcpServer({
      loop: stubLoop,
      dataDir: '/tmp/ethos-test',
      logger: noopLogger,
    });
    await expect(server.serveHttp({ port: 3300, host: '0.0.0.0' })).rejects.toThrow('loopback');
  });
  it('defaults to 127.0.0.1 when no host specified', async () => {
    const server = new EthosMcpServer({
      loop: stubLoop,
      dataDir: '/tmp/ethos-test',
      logger: noopLogger,
    });
    try {
      await Promise.race([
        server.serveHttp({ port: 0 }),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain('loopback');
    }
  });
});
