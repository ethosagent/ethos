import { createServer } from 'node:net';
/** Bind :0 so the kernel assigns a free port. Close immediately and return the port. */
export function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : null;
      server.close((err) => {
        if (err) reject(err);
        else if (!port) reject(new Error('kernel returned no port for :0 bind'));
        else resolve(port);
      });
    });
    server.once('error', reject);
  });
}
/** Returns true when a TCP connect succeeds (port in use). */
export function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err) => {
      resolve(err.code === 'EADDRINUSE');
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(false));
    });
  });
}
/**
 * Resolve a port for every team member.
 * Fixed ports are checked for availability; omitted ports are auto-allocated.
 * All allocations run in parallel to reduce startup latency and surface
 * conflicts early (CC-2: each allocation uses bind(:0) → kernel-guaranteed
 * uniqueness at allocation time).
 */
export async function allocatePorts(members) {
  return Promise.all(
    members.map(async (m) => {
      if (m.port !== undefined) {
        const inUse = await isPortInUse(m.port);
        if (inUse) {
          throw new Error(
            `Port ${m.port} for personality "${m.personality}" is already in use. ` +
              'Stop the process using it or remove the port override from team.yaml.',
          );
        }
        return { personality: m.personality, port: m.port };
      }
      const port = await allocatePort();
      return { personality: m.personality, port };
    }),
  );
}
