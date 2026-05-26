import { createSocket } from 'node:dgram';
export function notifyReady() {
  const socketPath = process.env.NOTIFY_SOCKET;
  if (!socketPath) return;
  try {
    // unix_dgram is supported at runtime but not in the TS type definitions
    const socket = createSocket('unix_dgram');
    socket.send('READY=1', socketPath, () => {
      socket.close();
    });
  } catch {
    // best-effort — never throw
  }
}
export function notifyWatchdog() {
  const socketPath = process.env.NOTIFY_SOCKET;
  if (!socketPath) return;
  try {
    const socket = createSocket('unix_dgram');
    socket.send('WATCHDOG=1', socketPath, () => {
      socket.close();
    });
  } catch {
    // best-effort — never throw
  }
}
export function startWatchdog() {
  const usec = process.env.WATCHDOG_USEC;
  if (!usec) return null;
  const pid = process.env.WATCHDOG_PID;
  if (pid && Number(pid) !== process.pid) return null;
  const intervalMs = Math.floor(Number(usec) / 1000 / 2);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  const timer = setInterval(() => notifyWatchdog(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
