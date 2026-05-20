import { createSocket, type Socket } from 'node:dgram';

export function notifyReady(): void {
  const socketPath = process.env.NOTIFY_SOCKET;
  if (!socketPath) return;
  try {
    // unix_dgram is supported at runtime but not in the TS type definitions
    // biome-ignore lint/suspicious/noExplicitAny: unix_dgram is valid at runtime but absent from TS types
    const socket: Socket = (createSocket as any)('unix_dgram');
    // biome-ignore lint/suspicious/noExplicitAny: send() overload for unix_dgram paths not in TS types
    (socket.send as any)('READY=1', socketPath, () => {
      socket.close();
    });
  } catch {
    // best-effort — never throw
  }
}
