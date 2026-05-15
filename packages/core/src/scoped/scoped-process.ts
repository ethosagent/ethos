import { spawn as nodeSpawn } from 'node:child_process';
import type { ProcessResult, ScopedProcess, SpawnOpts } from '@ethosagent/types';

export class ScopedProcessImpl implements ScopedProcess {
  constructor(private readonly allowedBinaries: Set<string>) {}

  async spawn(binary: string, args: string[], opts?: SpawnOpts): Promise<ProcessResult> {
    if (!this.allowedBinaries.has('*') && !this.allowedBinaries.has(binary)) {
      throw new Error(`BINARY_NOT_ALLOWED: ${binary} is not in the declared allowedBinaries`);
    }

    return new Promise((resolve, reject) => {
      const child = nodeSpawn(binary, args, {
        cwd: opts?.cwd,
        env: opts?.env ? { ...process.env, ...opts.env } : process.env,
        timeout: opts?.timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

      child.on('error', reject);
      child.on('close', (exitCode) => {
        resolve({
          exitCode: exitCode ?? 1,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        });
      });
    });
  }
}
