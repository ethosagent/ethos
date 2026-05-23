import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

let backendProcess: ChildProcess | null = null;

export function startBackend(port: number): void {
  if (backendProcess) return;

  const isDev = process.env.NODE_ENV === 'development';

  let cmd: string;
  let entryPath: string;

  if (isDev) {
    entryPath = join(app.getAppPath(), '..', '..', 'apps', 'web-api', 'src', 'index.ts');
    cmd = 'tsx';
  } else {
    entryPath = join(process.resourcesPath, 'web-api', 'index.js');
    cmd = process.execPath;
  }

  if (!isDev && !existsSync(entryPath)) {
    return;
  }

  const args = isDev ? [entryPath] : ['--', entryPath];

  backendProcess = spawn(cmd, args, {
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
