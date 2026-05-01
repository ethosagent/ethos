import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { loadRegistry, updateEntry } from './registry';

export interface SpawnResult {
  pid: number;
  stdoutLog: string;
  stderrLog: string;
}

export function spawnDetached(
  id: string,
  command: string,
  cwd: string,
  env: Record<string, string> | undefined,
  dataDir: string,
): SpawnResult {
  const dir = join(dataDir, 'processes', id);
  mkdirSync(dir, { recursive: true });

  const stdoutLog = join(dir, 'stdout.log');
  const stderrLog = join(dir, 'stderr.log');

  const outFd = openSync(stdoutLog, 'a');
  const errFd = openSync(stderrLog, 'a');

  const child = spawn(command, [], {
    shell: true,
    detached: true,
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ['ignore', outFd, errFd],
  });

  child.on('exit', (code, signal) => {
    const reg = loadRegistry(dataDir);
    const entry = reg[id];
    // If already marked killed/orphan/exited by process_stop, don't overwrite.
    if (!entry || entry.status !== 'running') return;
    if (signal !== null) {
      // Killed by an external signal — treat as orphan.
      updateEntry(dataDir, id, { status: 'orphan' });
    } else {
      updateEntry(dataDir, id, { status: 'exited', exitCode: code ?? -1 });
    }
  });

  child.unref();

  if (child.pid === undefined) {
    throw new Error('Failed to spawn process: pid is undefined');
  }

  return { pid: child.pid, stdoutLog, stderrLog };
}
