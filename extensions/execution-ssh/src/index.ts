import { type ChildProcess, spawn } from 'node:child_process';
import type {
  ExecChunk,
  ExecOpts,
  ExecSession,
  ExecutionBackend,
  ExecutionBackendConfig,
  Logger,
  MountSpec,
  PersonalityConfig,
  SandboxAttestation,
  SecretsResolver,
} from '@ethosagent/types';

export class ExecAbortedError extends Error {
  readonly code = 'EXEC_ABORTED';
  constructor(message = 'Execution aborted') {
    super(message);
    this.name = 'ExecAbortedError';
  }
}

export class ExecTimeoutError extends Error {
  readonly code = 'EXEC_TIMEOUT';
  constructor(message = 'Execution timed out') {
    super(message);
    this.name = 'ExecTimeoutError';
  }
}

export class SshHostMissingError extends Error {
  readonly code = 'SSH_HOST_MISSING';
  constructor(message = 'ssh backend requires config.ssh.host to be set') {
    super(message);
    this.name = 'SshHostMissingError';
  }
}

/**
 * Queue-backed async generator that streams interleaved stdout/stderr chunks
 * from a spawned child process. Self-contained per backend (duplicated, not
 * shared) so each execution package has zero cross-package coupling.
 */
async function* streamChild(child: ChildProcess, opts: ExecOpts): AsyncIterable<ExecChunk> {
  const chunks: ExecChunk[] = [];
  let done = false;
  let error: Error | null = null;
  let resolveNext: (() => void) | null = null;
  let exitCode: number | null = null;

  child.stdout?.on('data', (c: Buffer) => {
    chunks.push({ stream: 'stdout', data: c.toString('utf-8') });
    resolveNext?.();
  });
  child.stderr?.on('data', (c: Buffer) => {
    chunks.push({ stream: 'stderr', data: c.toString('utf-8') });
    resolveNext?.();
  });
  // ssh propagates the remote command's exit status as its own exit code.
  child.on('close', (code) => {
    exitCode = code ?? null;
    done = true;
    resolveNext?.();
  });
  child.on('error', (err: Error) => {
    error = err;
    done = true;
    resolveNext?.();
  });

  const timeoutMs = opts.timeoutMs ?? 30000;
  const timer = setTimeout(() => {
    error = new ExecTimeoutError();
    child.kill();
    done = true;
    resolveNext?.();
  }, timeoutMs);

  const signal = opts.signal;
  if (signal) {
    if (signal.aborted) {
      error = new ExecAbortedError();
      done = true;
    } else {
      signal.addEventListener(
        'abort',
        () => {
          error = new ExecAbortedError();
          child.kill();
          done = true;
          resolveNext?.();
        },
        { once: true },
      );
    }
  }

  if (opts.stdin !== undefined) child.stdin?.write(opts.stdin, 'utf-8');
  child.stdin?.end();

  try {
    while (true) {
      while (chunks.length > 0) {
        const c = chunks.shift();
        if (c) yield c;
      }
      if (error) throw error;
      if (done) {
        while (chunks.length > 0) {
          const c = chunks.shift();
          if (c) yield c;
        }
        yield { stream: 'exit', code: exitCode ?? -1 };
        break;
      }
      await new Promise<void>((r) => {
        resolveNext = r;
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SSH execution backend.
 *
 * NOTE: the ssh backend provides remote-host trust ONLY; it does NOT enforce
 * fs_reach mount-confinement and is EXCLUDED from the Phase-2a
 * Success-Criterion-1 containment guarantee (review A3). Commands run on a
 * remote host's real filesystem; there is no per-personality mount allowlist.
 */
export class SshExecutionBackend implements ExecutionBackend {
  readonly name = 'ssh';
  private readonly config: ExecutionBackendConfig;

  constructor(ctx: { config: ExecutionBackendConfig; secrets: SecretsResolver; logger: Logger }) {
    this.config = ctx.config;
  }

  private sshArgs(cmd: string): string[] {
    const ssh = this.config.ssh;
    if (!ssh?.host) throw new SshHostMissingError();
    const target = ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host;
    const args: string[] = [];
    if (ssh.port !== undefined) args.push('-p', String(ssh.port));
    if (ssh.identityFile) args.push('-i', ssh.identityFile);
    args.push(target, '--', cmd);
    return args;
  }

  isAvailable(): Promise<boolean> {
    if (!this.config.ssh?.host) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      try {
        const child = spawn('ssh', ['-V'], { stdio: 'ignore' });
        child.on('close', (exitCode) => resolve(exitCode === 0));
        child.on('error', () => resolve(false));
      } catch {
        resolve(false);
      }
    });
  }

  async *exec(cmd: string, opts: ExecOpts): AsyncIterable<ExecChunk> {
    const args = this.sshArgs(cmd);
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    yield* streamChild(child, opts);
  }

  spawnSession(personalityId: string): ExecSession {
    return {
      personalityId,
      exec: (cmd: string, opts: ExecOpts = {}) => this.exec(cmd, opts),
      dispose: () => Promise.resolve(),
    };
  }

  mountsFor(_p: PersonalityConfig): MountSpec[] {
    // ssh "mounts" are remote paths, NOT mount-confined. Lane B may revisit;
    // this backend is not part of the Phase-2a containment claim (review A3).
    return [];
  }

  attest(): SandboxAttestation {
    // SSH is remote-host trust, NOT mount-confined (review A3).
    // Commands run on a remote host's real filesystem with no per-personality
    // mount allowlist. Only noDockerSocket is true — the remote host's docker
    // socket is not mounted via SSH.
    return {
      readonlyRootFs: false,
      noHostMounts: false,
      egressControlled: false,
      noDockerSocket: true,
      nonRoot: false,
      noPrivileged: false,
      noCapAdd: false,
      capDropAll: false,
      noNewPrivs: false,
    };
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
