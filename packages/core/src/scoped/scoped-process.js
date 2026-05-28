import { spawn as nodeSpawn } from 'node:child_process';
export class ScopedProcessImpl {
  allowedBinaries;
  constructor(allowedBinaries) {
    this.allowedBinaries = allowedBinaries;
  }
  async spawn(binary, args, opts) {
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
      const stdout = [];
      const stderr = [];
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
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
