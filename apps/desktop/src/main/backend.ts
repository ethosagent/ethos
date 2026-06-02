import { startServer, stopServer } from './serve';

let serverRunning = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;

export function startBackend(port: number): void {
  if (serverRunning) return;
  serverRunning = true;

  startServer(port).catch((err: unknown) => {
    process.stderr.write(
      `[ethos-backend] failed to start in-process server: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    serverRunning = false;
  });
}

export function restartBackend(port: number): void {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const wasRunning = serverRunning;
  serverRunning = false;

  if (wasRunning) {
    stopServer()
      .then(() => {
        restartTimer = setTimeout(() => {
          restartTimer = null;
          startBackend(port);
        }, 600);
      })
      .catch((err: unknown) => {
        process.stderr.write(
          `[ethos-backend] error stopping server on restart: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        restartTimer = setTimeout(() => {
          restartTimer = null;
          startBackend(port);
        }, 600);
      });
  } else {
    startBackend(port);
  }
}

export function stopBackend(): void {
  serverRunning = false;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  stopServer().catch((err: unknown) => {
    process.stderr.write(
      `[ethos-backend] error stopping server: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  });
}
