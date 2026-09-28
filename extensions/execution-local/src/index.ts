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

/**
 * Host env vars the command inherits. The full `process.env` carries provider
 * keys, bot tokens and every `~/.ethos/.env` entry, so only the minimum a shell
 * needs is forwarded and the caller's explicit `env` is layered on top.
 *
 * The same list as `PASSTHROUGH_ENV_KEYS` in
 * `packages/core/src/scoped/scoped-process.ts` and
 * `extensions/tools-process/src/spawn.ts`, copied because this package depends
 * only on `@ethosagent/types`. The three change together. Pinned by the
 * 'LocalExecutionBackend env' case in `__tests__/local.test.ts` (UBP-048).
 */
const PASSTHROUGH_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TZ',
] as const;

function minimalHostEnv(env: Record<string, string> | undefined): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) base[key] = val;
  }
  return env ? { ...base, ...env } : base;
}

/** SIGTERM → SIGKILL grace after a timeout or abort. */
const KILL_GRACE_MS = 2_000;
/** After bash exits, how long its output pipes get to close before the group is killed. */
const EXIT_DRAIN_MS = 500;

/** Process groups exist on POSIX only; Windows signals the direct child. */
const USE_PROCESS_GROUP = process.platform !== 'win32';

/**
 * Signal the child's whole process group (it was spawned `detached`, so its
 * pid is the group id). Grandchildren a command started — `sleep 600; make`,
 * `npm run dev &` — die with it instead of being orphaned (UBP-007).
 */
function signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (USE_PROCESS_GROUP) process.kill(-pid, sig);
    else child.kill(sig);
  } catch {
    // ESRCH: the whole group has already exited — nothing left to signal.
  }
}

/** SIGTERM the group now, SIGKILL whatever is left after the grace period. */
function stopGroup(child: ChildProcess): void {
  signalGroup(child, 'SIGTERM');
  setTimeout(() => signalGroup(child, 'SIGKILL'), KILL_GRACE_MS).unref();
}

/**
 * Queue-backed async generator that streams interleaved stdout/stderr chunks
 * from a spawned child process. Self-contained per backend (duplicated, not
 * shared) so each execution package has zero cross-package coupling.
 *
 * Lifetime: completes on the child's exit plus a bounded drain
 * ({@link EXIT_DRAIN_MS}), never on `close` alone — a descendant holding the
 * pipes is killed with the group rather than wedging the exec. A timeout or
 * abort stops the whole group ({@link stopGroup}), and so does a consumer that
 * stops iterating early. Pinned by 'LocalExecutionBackend process lifetime' in
 * `__tests__/local.test.ts`.
 */
async function* streamChild(child: ChildProcess, opts: ExecOpts): AsyncIterable<ExecChunk> {
  const chunks: ExecChunk[] = [];
  let done = false;
  let error: Error | null = null;
  let resolveNext: (() => void) | null = null;
  let exitCode: number | null = null;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  child.stdout?.on('data', (c: Buffer) => {
    chunks.push({ stream: 'stdout', data: c.toString('utf-8') });
    resolveNext?.();
  });
  child.stderr?.on('data', (c: Buffer) => {
    chunks.push({ stream: 'stderr', data: c.toString('utf-8') });
    resolveNext?.();
  });
  child.on('exit', (code) => {
    exitCode = code ?? null;
    drainTimer = setTimeout(() => {
      signalGroup(child, 'SIGKILL');
      done = true;
      resolveNext?.();
    }, EXIT_DRAIN_MS);
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
    stopGroup(child);
    done = true;
    resolveNext?.();
  }, timeoutMs);

  const signal = opts.signal;
  const onAbort = () => {
    error = new ExecAbortedError();
    stopGroup(child);
    done = true;
    resolveNext?.();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  if (opts.stdin !== undefined) child.stdin?.write(opts.stdin, 'utf-8');
  child.stdin?.end();

  let completed = false;
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
        completed = true;
        // Terminal exit chunk (Lane C2). `null` (killed by signal with no code)
        // maps to -1 so a non-zero exit is always observable downstream.
        yield { stream: 'exit', code: exitCode ?? -1 };
        break;
      }
      await new Promise<void>((r) => {
        resolveNext = r;
      });
    }
  } finally {
    clearTimeout(timer);
    if (drainTimer !== undefined) clearTimeout(drainTimer);
    signal?.removeEventListener('abort', onAbort);
    // A consumer that stopped iterating early leaves no process behind.
    if (!completed && error === null) stopGroup(child);
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}

function spawnLocal(cmd: string, opts: ExecOpts): ChildProcess {
  return spawn('bash', ['-c', cmd], {
    cwd: opts.cwd,
    // UBP-048 — never the host's full, secret-bearing process.env.
    env: minimalHostEnv(opts.env),
    detached: USE_PROCESS_GROUP,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export class LocalExecutionBackend implements ExecutionBackend {
  readonly name = 'local';

  // Constructor accepts (and ignores) ctx so the wiring factory
  // `(ctx) => new LocalExecutionBackend(ctx)` typechecks against
  // ExecutionBackendFactory. Local execution needs no config/secrets/logger.
  // biome-ignore lint/complexity/noUselessConstructor: must accept ctx to satisfy the factory contract
  constructor(_ctx: { config: ExecutionBackendConfig; secrets: SecretsResolver; logger: Logger }) {}

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  exec(cmd: string, opts: ExecOpts): AsyncIterable<ExecChunk> {
    return streamChild(spawnLocal(cmd, opts), opts);
  }

  spawnSession(personalityId: string): ExecSession {
    return {
      personalityId,
      exec: (cmd: string, opts: ExecOpts = {}) => streamChild(spawnLocal(cmd, opts), opts),
      dispose: () => Promise.resolve(),
    };
  }

  mountsFor(_p: PersonalityConfig): MountSpec[] {
    // Lane B (component d): real mount derivation
    return [];
  }

  attest(): SandboxAttestation {
    // Local execution is NOT sandboxed — all confinement booleans are false
    // except noDockerSocket (the local backend doesn't mount docker.sock).
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
