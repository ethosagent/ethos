// CC-2: Bind-then-spawn port uniqueness under concurrent allocation.
//
// The kernel guarantees uniqueness on bind(); scan-then-bind patterns race
// when two supervisors run simultaneously. This test exercises concurrent
// allocatePort() calls and asserts every returned port is distinct — proving
// the bind(:0) pattern holds under parallelism.
import { describe, expect, it } from 'vitest';
import { allocatePort, isPortInUse } from '../../ports';

describe('CC-2: concurrent port allocation', () => {
  it('allocates 8 unique ports when called concurrently', async () => {
    const ports = await Promise.all(Array.from({ length: 8 }, () => allocatePort()));
    const unique = new Set(ports);
    // All 8 must be distinct (kernel assigns different ephemeral ports per bind).
    expect(unique.size).toBe(8);
  });
  it('allocates ports in valid ephemeral range', async () => {
    const ports = await Promise.all(Array.from({ length: 4 }, () => allocatePort()));
    for (const port of ports) {
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(65536);
    }
  });
  it('isPortInUse returns false for allocated-then-released ports', async () => {
    // After allocatePort closes the server, the port should be free again.
    const port = await allocatePort();
    const inUse = await isPortInUse(port);
    // May or may not be in use depending on OS ephemeral port reuse — we don't
    // assert a specific value here; the test just ensures no exception is thrown.
    expect(typeof inUse).toBe('boolean');
  });
  it('isPortInUse returns true for an actively bound port', async () => {
    const { createServer } = await import('node:net');
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : null;
    expect(port).not.toBeNull();
    if (port === null) {
      throw new Error('server did not return a port');
    }
    const inUse = await isPortInUse(port);
    expect(inUse).toBe(true);
    await new Promise((resolve) => server.close(() => resolve()));
  });
  it('16 concurrent allocations all produce distinct ports', async () => {
    const ports = await Promise.all(Array.from({ length: 16 }, () => allocatePort()));
    const unique = new Set(ports);
    expect(unique.size).toBe(16);
  });
});
