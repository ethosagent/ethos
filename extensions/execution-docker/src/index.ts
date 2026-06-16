import { type ChildProcess, spawn } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
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

export class ForbiddenMountError extends Error {
  readonly code = 'FORBIDDEN_MOUNT';
  constructor(public readonly path: string) {
    super(`Refusing to mount a forbidden host path: ${path}`);
    this.name = 'ForbiddenMountError';
  }
}

/**
 * Built-in critical denylist (review A2). These host paths grant container
 * escape (docker socket) or expose the host kernel/devices; `mountsFor`
 * refuses them UNCONDITIONALLY — independent of any constitution. A path is
 * forbidden if its resolved absolute form equals a denied root or is nested
 * under one (e.g. `/proc/self`, `/dev/mem`).
 */
const FORBIDDEN_MOUNT_ROOTS = [
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/proc',
  '/sys',
  '/dev',
] as const;

/** Ephemeral writable scratch (review #5). tmpfs — not a host bind mount. */
const SCRATCH_TMPFS_PATHS = ['/tmp', '/home/sandbox'] as const;

/** Output byte ceiling per exec (review #6). Past this the exec is killed. */
const MAX_EXEC_OUTPUT_BYTES = 1_000_000;

/** True when `p` resolves to or under one of the forbidden mount roots. */
function isForbiddenMount(p: string): boolean {
  const abs = resolvePath(p);
  return FORBIDDEN_MOUNT_ROOTS.some((root) => abs === root || abs.startsWith(`${root}/`));
}

/** Local copy of the core substitution helper — extensions must not import core. */
function substitute(
  template: string,
  vars: { ethosHome: string; self: string; cwd: string },
): string {
  return template
    .replace(/\$\{ETHOS_HOME\}/g, vars.ethosHome)
    .replace(/\$\{self\}/g, vars.self)
    .replace(/\$\{CWD\}/g, vars.cwd);
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
 * Byte-ceiling wrapper (review #6). Counts bytes yielded by `inner`; once the
 * running total exceeds `maxBytes` it kills the child + container, emits a
 * final stderr truncation marker, and stops. The cap is enforced HERE — inside
 * the exec stream — so host memory stays bounded regardless of downstream
 * result trimming.
 */
export async function* withByteCeiling(
  inner: AsyncIterable<ExecChunk>,
  maxBytes: number,
  onCeiling: () => void,
): AsyncIterable<ExecChunk> {
  let total = 0;
  for await (const chunk of inner) {
    total += Buffer.byteLength(chunk.data, 'utf-8');
    if (total > maxBytes) {
      onCeiling();
      yield { stream: 'stderr', data: `\n[output truncated at ${maxBytes} bytes]\n` };
      return;
    }
    yield chunk;
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
  mounts?: MountSpec[];
  tmpfs?: readonly string[];
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
  // Ephemeral writable scratch (review #5) — discarded on container teardown.
  for (const path of opts.tmpfs ?? []) {
    args.push('--tmpfs', path);
  }
  // Host bind mounts derived from fs_reach (review d). The container sees ONLY
  // these host paths; nothing else from the host is reachable.
  for (const m of opts.mounts ?? []) {
    args.push('-v', `${m.hostPath}:${m.containerPath}:${m.mode}`);
  }
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
    const mounts = opts.personality ? this.mountsFor(opts.personality) : [];
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
      mounts,
      tmpfs: SCRATCH_TMPFS_PATHS,
    });
    const killContainer = () => {
      spawn('docker', ['kill', containerName], { stdio: 'ignore' }).on('close', () => {
        spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
      });
    };
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    yield* withByteCeiling(
      streamChild(child, opts, killContainer),
      MAX_EXEC_OUTPUT_BYTES,
      killContainer,
    );
  }

  spawnSession(personalityId: string): ExecSession {
    return {
      personalityId,
      exec: (cmd: string, opts: ExecOpts = {}) => this.exec(cmd, opts),
      dispose: () => Promise.resolve(),
    };
  }

  /**
   * Derive the container's host-mount set mechanically from `fs_reach`
   * (review d). `read[]` → ro, `write[]` → rw, with `hostPath === containerPath`
   * (the resolved host path is bound at the same path inside the container).
   * Substitutions are resolved first. When `fs_reach` is unset the SAME defaults
   * as ScopedStorage apply: read=[ownDir, ${ethosHome}/skills/, cwd],
   * write=[ownDir, cwd] where ownDir=${ethosHome}/personalities/<id>/.
   *
   * Refuses the built-in critical denylist unconditionally (review A2). Nested
   * ro-parent / rw-child mounts are BOTH kept — the child shadows the parent in
   * its subtree (review A7). When the SAME exact path appears as both ro and
   * rw, rw wins: write access subsumes read, so the path is mounted rw. (This
   * is also why the default scope — which lists ownDir/cwd in both read and
   * write — resolves cleanly to rw for those roots.)
   */
  mountsFor(p: PersonalityConfig): MountSpec[] {
    const ethosHome = this.config.substitutionVars?.ethosHome ?? join(homedir(), '.ethos');
    const cwd = this.config.substitutionVars?.cwd ?? process.cwd();
    const self = p.id;
    const ownDir = `${join(ethosHome, 'personalities', self)}/`;

    const reach = p.fs_reach;
    const readPaths =
      reach?.read && reach.read.length > 0
        ? reach.read.map((path) => substitute(path, { ethosHome, self, cwd }))
        : [ownDir, `${join(ethosHome, 'skills')}/`, cwd];
    const writePaths =
      reach?.write && reach.write.length > 0
        ? reach.write.map((path) => substitute(path, { ethosHome, self, cwd }))
        : [ownDir, cwd];

    const byPath = new Map<string, MountSpec>();
    const add = (rawPath: string, mode: 'ro' | 'rw'): void => {
      const hostPath = resolvePath(rawPath);
      if (isForbiddenMount(hostPath)) throw new ForbiddenMountError(hostPath);
      const existing = byPath.get(hostPath);
      // rw wins: write access subsumes read. Dedups identical (path, mode) too.
      if (existing && (existing.mode === 'rw' || mode === 'ro')) return;
      byPath.set(hostPath, { hostPath, containerPath: hostPath, mode });
    };

    // Add writes first so the rw mode is established before any ro of the same
    // path is seen; the rw-wins guard above then keeps rw regardless of order.
    for (const path of writePaths) add(path, 'rw');
    for (const path of readPaths) add(path, 'ro');
    return [...byPath.values()];
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
