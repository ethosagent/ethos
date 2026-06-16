import { type ChildProcess, spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import type {
  ExecChunk,
  ExecOpts,
  ExecSession,
  ExecutionBackend,
  ExecutionBackendConfig,
  Logger,
  MountSpec,
  PersonalityConfig,
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

export class InvalidImageRefError extends Error {
  readonly code = 'INVALID_IMAGE_REF';
  constructor(public readonly ref: string) {
    super(`Image ref must be digest-pinned (@sha256:): ${ref}`);
    this.name = 'InvalidImageRefError';
  }
}

export class DockerUnavailableError extends Error {
  readonly code = 'DOCKER_UNAVAILABLE';
  constructor() {
    super('Docker is not available; refusing to fall back to local execution');
    this.name = 'DockerUnavailableError';
  }
}

/**
 * Queue-backed async generator that streams interleaved stdout/stderr chunks
 * from a spawned child process. Self-contained per backend (duplicated, not
 * shared) so each execution package has zero cross-package coupling.
 */
async function* streamChild(
  child: ChildProcess,
  opts: ExecOpts,
  killContainer: () => void,
): AsyncIterable<ExecChunk> {
  const chunks: ExecChunk[] = [];
  let done = false;
  let error: Error | null = null;
  let resolveNext: (() => void) | null = null;

  child.stdout?.on('data', (c: Buffer) => {
    chunks.push({ stream: 'stdout', data: c.toString('utf-8') });
    resolveNext?.();
  });
  child.stderr?.on('data', (c: Buffer) => {
    chunks.push({ stream: 'stderr', data: c.toString('utf-8') });
    resolveNext?.();
  });
  child.on('close', () => {
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
    child.kill('SIGKILL');
    killContainer();
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
          child.kill('SIGKILL');
          killContainer();
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
 * Build `docker run` args (after the program name). Pure — no spawning.
 * Throws InvalidImageRefError unless the image is digest-pinned (@sha256:).
 */
export function buildDockerArgs(opts: {
  image: string;
  cmd: string;
  containerName: string;
  memoryMb: number;
  networkMode: 'none' | 'bridge';
  uid: number;
  gid: number;
  stdin: boolean;
  env?: Record<string, string>;
}): string[] {
  if (!opts.image.includes('@sha256:')) {
    throw new InvalidImageRefError(opts.image);
  }
  const args: string[] = ['run', '--rm', '--name', opts.containerName];
  if (opts.stdin) args.push('-i');
  args.push('--network', opts.networkMode);
  args.push(`--memory=${opts.memoryMb}m`, '--memory-swap', `${opts.memoryMb}m`);
  args.push('--cpus', '2', '--pids-limit', '256');
  args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges');
  // uid/gid are -1 on Windows; CI is macOS/Linux
  if (opts.uid >= 0 && opts.gid >= 0) {
    args.push('--user', `${opts.uid}:${opts.gid}`);
  }
  args.push('--pull=never');
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      args.push('-e', `${k}=${v}`);
    }
  }
  args.push('--', opts.image, 'bash', '-lc', opts.cmd);
  return args;
}

function defaultDockerInfoCheck(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn('docker', ['info'], { stdio: 'ignore' });
      child.on('close', (exitCode) => resolve(exitCode === 0));
      child.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

export class DockerExecutionBackend implements ExecutionBackend {
  readonly name = 'docker';
  private readonly config: ExecutionBackendConfig;
  private readonly checkAvailable: () => Promise<boolean>;

  constructor(
    ctx: { config: ExecutionBackendConfig; secrets: SecretsResolver; logger: Logger },
    checkAvailable?: () => Promise<boolean>,
  ) {
    this.config = ctx.config;
    this.checkAvailable = checkAvailable ?? defaultDockerInfoCheck;
  }

  isAvailable(): Promise<boolean> {
    return this.checkAvailable();
  }

  // Image convention: resolve from config.images[runtime]; runtime defaults to 'default'.
  async *exec(cmd: string, opts: ExecOpts): AsyncIterable<ExecChunk> {
    if (!(await this.checkAvailable())) throw new DockerUnavailableError();
    const image = this.config.images?.default ?? '';
    if (!image) throw new InvalidImageRefError(image);

    const memoryMb = this.config.memoryMb ?? 256;
    const containerName = `ethos-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const info = userInfo();
    const args = buildDockerArgs({
      image,
      cmd,
      containerName,
      memoryMb,
      networkMode: 'none',
      uid: info.uid,
      gid: info.gid,
      stdin: opts.stdin !== undefined,
      env: opts.env,
    });
    const killContainer = () => {
      spawn('docker', ['kill', containerName], { stdio: 'ignore' }).on('close', () => {
        spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
      });
    };
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    yield* streamChild(child, opts, killContainer);
  }

  spawnSession(personalityId: string): ExecSession {
    return {
      personalityId,
      exec: (cmd: string, opts: ExecOpts = {}) => this.exec(cmd, opts),
      dispose: () => Promise.resolve(),
    };
  }

  mountsFor(_p: PersonalityConfig): MountSpec[] {
    // Lane B (component d): derive from fs_reach
    return [];
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
