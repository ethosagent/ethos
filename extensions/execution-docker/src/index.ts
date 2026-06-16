// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach substitution
// tokens (`${ETHOS_HOME}` etc.) are literal markers resolved at runtime, not JS
// template strings.
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

export class EmptySubstitutionError extends Error {
  readonly code = 'EMPTY_SUBSTITUTION';
  constructor(
    public readonly variable: string,
    public readonly template: string,
  ) {
    super(`Substitution variable ${variable} is empty/unresolved in fs_reach path "${template}"`);
    this.name = 'EmptySubstitutionError';
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

/**
 * Scratch tmpfs entries that don't collide with a derived fs_reach mount.
 * Precedence: an explicit fs_reach bind mount wins over the convenience
 * scratch tmpfs — when both target the same mount point, Docker rejects the
 * container ("Duplicate mount point"), so we drop the scratch entry and let
 * the fs_reach bind provide that path.
 */
export function scratchTmpfsFor(mounts: MountSpec[]): string[] {
  const mounted = new Set(mounts.map((m) => m.containerPath));
  return SCRATCH_TMPFS_PATHS.filter((p) => !mounted.has(p));
}

/** Output byte ceiling per exec (review #6). Past this the exec is killed. */
const MAX_EXEC_OUTPUT_BYTES = 1_000_000;

/** True when `p` resolves to or under one of the forbidden mount roots. */
function isForbiddenMount(p: string): boolean {
  const abs = resolvePath(p);
  return FORBIDDEN_MOUNT_ROOTS.some((root) => abs === root || abs.startsWith(`${root}/`));
}

/**
 * Local copy of the core substitution helper — extensions must not import core.
 * Throws EmptySubstitutionError when a token present in the template maps to an
 * empty value: an explicitly-declared fs_reach path whose substitution variable
 * is empty is a configuration error — fail loudly rather than mount a bogus path
 * (e.g. `${ETHOS_HOME}/skills` with an empty ethosHome would bind `/skills`).
 */
function substitute(
  template: string,
  vars: { ethosHome: string; self: string; cwd: string },
): string {
  const checks: Array<[token: string, re: RegExp, value: string]> = [
    ['${ETHOS_HOME}', /\$\{ETHOS_HOME\}/g, vars.ethosHome],
    ['${self}', /\$\{self\}/g, vars.self],
    ['${CWD}', /\$\{CWD\}/g, vars.cwd],
  ];
  let out = template;
  for (const [token, re, value] of checks) {
    if (template.includes(token)) {
      if (value === '') throw new EmptySubstitutionError(token, template);
      out = out.replace(re, value);
    }
  }
  return out;
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
  let exitCode: number | null = null;

  child.stdout?.on('data', (c: Buffer) => {
    chunks.push({ stream: 'stdout', data: c.toString('utf-8') });
    resolveNext?.();
  });
  child.stderr?.on('data', (c: Buffer) => {
    chunks.push({ stream: 'stderr', data: c.toString('utf-8') });
    resolveNext?.();
  });
  // `docker run` exits with the in-container command's exit code (bash -lc cmd).
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
    // The terminal exit chunk carries no payload — pass it through untouched so
    // the exit code survives truncation, and don't count it toward the ceiling.
    if (chunk.stream === 'exit') {
      yield chunk;
      continue;
    }
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

/**
 * Build `docker run -d ... sleep infinity` args for a long-lived session
 * container. Distinct from buildDockerArgs (which is `--rm` + `bash -lc cmd`):
 * this keeps the container alive so a persistent `docker exec` shell can run
 * many commands against it. Throws InvalidImageRefError unless digest-pinned.
 */
export function buildKeepAliveArgs(opts: {
  image: string;
  containerName: string;
  memoryMb: number;
  networkMode: 'none' | 'bridge';
  uid: number;
  gid: number;
  mounts?: MountSpec[];
  tmpfs?: readonly string[];
}): string[] {
  if (!opts.image.includes('@sha256:')) {
    throw new InvalidImageRefError(opts.image);
  }
  const args: string[] = ['run', '-d', '--name', opts.containerName];
  args.push('--network', opts.networkMode);
  args.push(`--memory=${opts.memoryMb}m`, '--memory-swap', `${opts.memoryMb}m`);
  args.push('--cpus', '2', '--pids-limit', '256');
  args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges');
  if (opts.uid >= 0 && opts.gid >= 0) {
    args.push('--user', `${opts.uid}:${opts.gid}`);
  }
  args.push('--pull=never');
  for (const path of opts.tmpfs ?? []) {
    args.push('--tmpfs', path);
  }
  for (const m of opts.mounts ?? []) {
    args.push('-v', `${m.hostPath}:${m.containerPath}:${m.mode}`);
  }
  args.push('--', opts.image, 'sleep', 'infinity');
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

/**
 * Persistent docker-exec shell. One serialized command at a time (the queue in
 * `exec`). Each command is bracketed by a per-command sentinel emitted on BOTH
 * stdout and stderr (Lane C2): the stderr sentinel bounds that command's stderr
 * so it never bleeds into the next command's exec, and `runOne` declares the
 * command done only once both sentinels have arrived — making per-command
 * stderr ordering deterministic relative to completion. The stdout sentinel
 * also carries `$?`, which is surfaced as a terminal `{ stream: 'exit', code }`
 * chunk.
 */
class DockerPersistentSession implements ExecSession {
  readonly personalityId: string;
  private readonly backend: DockerExecutionBackend;
  private readonly config: ExecutionBackendConfig;
  private container: string | null = null;
  private shell: ChildProcess | null = null;
  private started = false;
  private disposed = false;
  private starting: Promise<void> | null = null;
  // serialize execs on the single persistent shell — one command at a time
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    backend: DockerExecutionBackend,
    personalityId: string,
    config: ExecutionBackendConfig,
  ) {
    this.backend = backend;
    this.personalityId = personalityId;
    this.config = config;
  }

  private async start(opts: ExecOpts): Promise<void> {
    if (this.started) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (!(await this.backend.isAvailable())) throw new DockerUnavailableError();
      const image = this.config.images?.default ?? '';
      if (!image) throw new InvalidImageRefError(image);
      const memoryMb = this.config.memoryMb ?? 256;
      const containerName = `ethos-sandbox-sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const info = userInfo();
      const mounts = opts.personality ? this.backend.mountsFor(opts.personality) : [];
      const args = buildKeepAliveArgs({
        image,
        containerName,
        memoryMb,
        networkMode: 'none',
        uid: info.uid,
        gid: info.gid,
        mounts,
        tmpfs: scratchTmpfsFor(mounts),
      });
      await new Promise<void>((resolve, reject) => {
        const run = spawn('docker', args, { stdio: 'ignore' });
        run.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`docker run failed (${code})`)),
        );
        run.on('error', reject);
      });
      this.container = containerName;
      this.shell = spawn('docker', ['exec', '-i', containerName, 'bash'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.started = true;
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  exec(cmd: string, opts: ExecOpts = {}): AsyncIterable<ExecChunk> {
    const self = this;
    async function* gen(): AsyncIterable<ExecChunk> {
      await self.start(opts);
      const shell = self.shell;
      if (!shell?.stdin || !shell.stdout) throw new DockerUnavailableError();
      // serialize: chain onto the queue so only one command runs at a time
      let release: () => void = () => {};
      const prev = self.queue;
      self.queue = new Promise<void>((r) => {
        release = r;
      });
      await prev;
      try {
        yield* withByteCeiling(self.runOne(shell, cmd, opts), MAX_EXEC_OUTPUT_BYTES, () => {});
      } finally {
        release();
      }
    }
    return gen();
  }

  private async *runOne(
    shell: ChildProcess,
    cmd: string,
    opts: ExecOpts,
  ): AsyncIterable<ExecChunk> {
    const sentinel = `__ETHOS_EOT_${Math.random().toString(36).slice(2)}__`;
    const chunks: ExecChunk[] = [];
    // Each stream's sentinel marks its end-of-command boundary. The command is
    // `done` only once BOTH have arrived, so a command's stderr is fully drained
    // (and bounded to this command) before the exec completes.
    let stdoutSeen = false;
    let stderrSeen = false;
    let error: Error | null = null;
    let resolveNext: (() => void) | null = null;
    let stdoutBuf = '';
    let stderrBuf = '';
    // Exit code parsed from the digits following the stdout sentinel.
    let exitCode: number | null = null;

    const settled = () => stdoutSeen && stderrSeen;

    const onStdout = (b: Buffer) => {
      stdoutBuf += b.toString('utf-8');
      const idx = stdoutBuf.indexOf(sentinel);
      if (idx >= 0) {
        let pre = stdoutBuf.slice(0, idx);
        if (pre.endsWith('\n')) pre = pre.slice(0, -1);
        if (pre.length > 0) chunks.push({ stream: 'stdout', data: pre });
        // After the sentinel: `<code>\n`. Wait for the trailing newline so the
        // digits are complete even when split across socket reads.
        const after = stdoutBuf.slice(idx + sentinel.length);
        const nl = after.indexOf('\n');
        if (nl >= 0) {
          const parsed = Number.parseInt(after.slice(0, nl), 10);
          exitCode = Number.isNaN(parsed) ? -1 : parsed;
          stdoutSeen = true;
          stdoutBuf = '';
        }
        // else: sentinel arrived but code digits not yet; keep buffering.
      } else {
        const safe = stdoutBuf.length - sentinel.length;
        if (safe > 0) {
          chunks.push({ stream: 'stdout', data: stdoutBuf.slice(0, safe) });
          stdoutBuf = stdoutBuf.slice(safe);
        }
      }
      resolveNext?.();
    };
    const onStderr = (b: Buffer) => {
      stderrBuf += b.toString('utf-8');
      const idx = stderrBuf.indexOf(sentinel);
      if (idx >= 0) {
        let pre = stderrBuf.slice(0, idx);
        if (pre.endsWith('\n')) pre = pre.slice(0, -1);
        if (pre.length > 0) chunks.push({ stream: 'stderr', data: pre });
        stderrSeen = true;
        stderrBuf = '';
      } else {
        const safe = stderrBuf.length - sentinel.length;
        if (safe > 0) {
          chunks.push({ stream: 'stderr', data: stderrBuf.slice(0, safe) });
          stderrBuf = stderrBuf.slice(safe);
        }
      }
      resolveNext?.();
    };
    shell.stdout?.on('data', onStdout);
    shell.stderr?.on('data', onStderr);

    const timeoutMs = opts.timeoutMs ?? 30000;
    const timer = setTimeout(() => {
      error = new ExecTimeoutError();
      stdoutSeen = true;
      stderrSeen = true;
      resolveNext?.();
    }, timeoutMs);
    const signal = opts.signal;
    const onAbort = () => {
      error = new ExecAbortedError();
      stdoutSeen = true;
      stderrSeen = true;
      resolveNext?.();
    };
    if (signal) {
      if (signal.aborted) {
        error = new ExecAbortedError();
        stdoutSeen = true;
        stderrSeen = true;
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // Run the command, capture `$?`, then emit the stderr sentinel BEFORE the
    // stdout sentinel (same shell, sequential writes) so this command's stderr
    // boundary is flushed ahead of the stdout completion marker. The stdout
    // sentinel carries the exit code.
    shell.stdin?.write(
      `${cmd}\n__ethos_rc=$?\nprintf '\\n%s\\n' "${sentinel}" 1>&2\nprintf '\\n%s%d\\n' "${sentinel}" "$__ethos_rc"\n`,
      'utf-8',
    );

    try {
      while (true) {
        while (chunks.length > 0) {
          const c = chunks.shift();
          if (c) yield c;
        }
        if (error) throw error;
        if (settled()) {
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
      shell.stdout?.off('data', onStdout);
      shell.stderr?.off('data', onStderr);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Signal the in-container process(es) (Lane C2). The container runs as a
   * non-root user in its own PID namespace; `kill -<sig> -1` broadcasts to every
   * process the user owns (the exec'd command and its children) without touching
   * the host. The session container is dedicated to one logical workload, so a
   * broadcast is the correct "stop this process" semantics. Best-effort: a
   * not-yet-started or already-gone container is a no-op, not an error.
   */
  async stop(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    const name = this.container;
    if (!name) return;
    const sig = signal === 'SIGKILL' ? 'KILL' : 'TERM';
    await new Promise<void>((resolve) => {
      const p = spawn('docker', ['exec', name, 'sh', '-c', `kill -${sig} -1 2>/dev/null || true`], {
        stdio: 'ignore',
      });
      p.on('close', () => resolve());
      p.on('error', () => resolve());
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.shell?.stdin?.end();
    } catch {
      /* shell may already be closed */
    }
    this.shell?.kill('SIGKILL');
    const name = this.container;
    if (name) {
      spawn('docker', ['rm', '-f', name], { stdio: 'ignore' });
    }
  }
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
      tmpfs: scratchTmpfsFor(mounts),
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
    return new DockerPersistentSession(this, personalityId, this.config);
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
