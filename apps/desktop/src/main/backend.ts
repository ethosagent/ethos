import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { store } from './store';

let backendProcess: ChildProcess | null = null;

export function startBackend(port: number): void {
  if (backendProcess) return;

  const isDev = process.env.NODE_ENV === 'development';

  if (isDev) {
    const monoRoot = join(app.getAppPath(), '..', '..');
    const tsx = join(monoRoot, 'node_modules', '.bin', 'tsx');
    const ethosAppDir = join(monoRoot, 'apps', 'ethos');

    let spawnPath = process.env.PATH ?? '';
    try {
      const nvmrcContent = readFileSync(join(monoRoot, '.nvmrc'), 'utf8').trim();
      if (nvmrcContent) {
        const nvmVersionsDir = join(homedir(), '.nvm', 'versions', 'node');
        const versions = readdirSync(nvmVersionsDir);
        const matchingVersion = versions.find((v) => v.startsWith(`v${nvmrcContent}`));
        if (matchingVersion) {
          const nvmBinDir = join(nvmVersionsDir, matchingVersion, 'bin');
          if (existsSync(nvmBinDir)) {
            spawnPath = `${nvmBinDir}:${spawnPath}`;
          }
        }
      }
    } catch {
      // no .nvmrc, no nvm dir, or no matching version — use existing PATH
    }

    backendProcess = spawn(
      tsx,
      ['src/index.ts', 'serve', '--web-port', String(port), '--port', String(port + 1)],
      {
        env: {
          ...process.env,
          NODE_ENV: 'development',
          PATH: spawnPath,
          ...(store.get('dataDir') ? { ETHOS_STATE_DIR: store.get('dataDir') } : {}),
        },
        cwd: ethosAppDir,
        stdio: 'pipe',
        detached: false,
      },
    );
    backendProcess.on('error', (err) => {
      process.stderr.write(`[ethos-backend] spawn error: ${err.message}\n`);
    });
    backendProcess.stdout?.on('data', (data: Buffer) => {
      process.stdout.write(`[ethos-backend] ${data}`);
    });
    backendProcess.stderr?.on('data', (data: Buffer) => {
      process.stderr.write(`[ethos-backend] ${data}`);
    });
  } else {
    const entryPath = join(process.resourcesPath, 'ethos', 'index.js');
    if (!existsSync(entryPath)) return;

    backendProcess = spawn(
      process.execPath,
      ['--', entryPath, 'serve', '--web-port', String(port), '--port', String(port + 1)],
      {
        env: {
          ...process.env,
          NODE_ENV: 'production',
          ...(store.get('dataDir') ? { ETHOS_STATE_DIR: store.get('dataDir') } : {}),
        },
        stdio: 'pipe',
        detached: false,
      },
    );
    backendProcess.stdout?.on('data', (data: Buffer) => {
      process.stdout.write(`[ethos-backend] ${data}`);
    });
    backendProcess.stderr?.on('data', (data: Buffer) => {
      process.stderr.write(`[ethos-backend] ${data}`);
    });
  }

  backendProcess.on('exit', (code, signal) => {
    process.stderr.write(`[ethos-backend] process exited — code: ${code}, signal: ${signal}\n`);
    backendProcess = null;
  });
}

export function restartBackend(port: number): void {
  if (backendProcess) {
    const old = backendProcess;
    backendProcess = null;
    old.kill();
    // Wait for the old process to release its port before spawning the new one.
    setTimeout(() => startBackend(port), 600);
  } else {
    startBackend(port);
  }
}

export function stopBackend(): void {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
}
