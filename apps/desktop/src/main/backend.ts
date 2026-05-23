import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { app } from 'electron';

let backendProcess: ChildProcess | null = null;

export function startBackend(port: number): void {
  if (backendProcess) return;

  const isDev = process.env.NODE_ENV === 'development';
  const entryPath = isDev
    ? join(app.getAppPath(), '..', '..', 'apps', 'web-api', 'src', 'index.ts')
    : join(app.getAppPath(), '..', 'web-api', 'index.js');

  const cmd = isDev ? 'tsx' : 'node';

  backendProcess = spawn(cmd, [entryPath], {
    env: { ...process.env, PORT: String(port), NODE_ENV: process.env.NODE_ENV || 'production' },
    stdio: 'pipe',
    detached: false,
  });

  backendProcess.on('exit', () => {
    backendProcess = null;
  });
}

export function stopBackend(): void {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
}
