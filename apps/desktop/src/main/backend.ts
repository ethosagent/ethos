import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getPort, startServer, stopServer } from './serve';
import { store } from './store';

let serverRunning = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;

function logBackendError(message: string): void {
  const dataDir = (() => {
    try {
      return store.get('dataDir') ?? join(homedir(), '.ethos');
    } catch {
      return join(homedir(), '.ethos');
    }
  })();
  const logPath = join(dataDir, 'ethos.log');

  process.stderr.write(message);
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${message}`);
  } catch {
    // logging must never throw
  }
}

export function startBackend(port: number): void {
  if (serverRunning) return;
  serverRunning = true;

  startServer(port).catch((err: unknown) => {
    logBackendError(
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
        logBackendError(
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
    logBackendError(
      `[ethos-backend] error stopping server: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  });
}

async function pollHealth(port: number, attempts = 10, intervalMs = 500): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Backend health check failed after ${attempts} attempts`);
}

export async function startBackendAsync(port: number): Promise<number> {
  if (serverRunning) return getPort() ?? port;
  serverRunning = true;
  try {
    const actual = await startServer(port);
    await pollHealth(actual);
    return actual;
  } catch (err) {
    serverRunning = false;
    throw err;
  }
}

export async function restartBackendAsync(port: number): Promise<number> {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  serverRunning = false;
  await stopServer();
  await new Promise((r) => setTimeout(r, 300));
  return startBackendAsync(port);
}
