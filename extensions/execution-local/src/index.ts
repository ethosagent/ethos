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
 * The same allowlist as `packages/core/src/scoped/scoped-process.ts`,
 * `extensions/tools-process/src/spawn.ts` and
 * `extensions/execution-process-backend/src/index.ts`, copied because this
 * package depends only on `@ethosagent/types`. The four change together.
 * Pinned by the 'LocalExecutionBackend env' cases in `__tests__/local.test.ts`
 * (UBP-048, V-ES-8).
 */
const PASSTHROUGH_ENV_KEYS: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TERM',
  'COLORTERM',
  'TMPDIR',
  'TZ',
  // V-ES-8: without these `git push` over ssh, a corporate proxy, the locale
  // macOS sets (LC_CTYPE only) and the common toolchain roots all break.
  'SSH_AUTH_SOCK',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'NODE_PATH',
  'GOPATH',
  'GOROOT',
  'GOBIN',
  'JAVA_HOME',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'PYENV_ROOT',
  'PYTHONPATH',
  'VIRTUAL_ENV',
]);
/** Whole families forwarded by prefix: locale, nvm, conda, XDG dirs, terminal identity. */
const PASSTHROUGH_ENV_PREFIXES = ['LC_', 'NVM_', 'CONDA_', 'XDG_', 'TERM_'] as const;
/** A name that looks like a credential is never forwarded, even inside an allowed family. */
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|(?:^|_)API(?:_|$)|^AWS_/i;

/**
 * True when `key` may pass from the host env to a child. Names `loadDotEnv`
 * copied in from `~/.ethos/.env` (recorded in `ETHOS_DOTENV_KEYS`,
 * packages/storage-fs/src/env-secrets.ts) never pass, whatever they are.
 */
function isPassthroughEnvKey(key: string, dotenvKeys: ReadonlySet<string>): boolean {
  if (dotenvKeys.has(key) || SECRET_ENV_NAME.test(key)) return false;
  return PASSTHROUGH_ENV_KEYS.has(key) || PASSTHROUGH_ENV_PREFIXES.some((p) => key.startsWith(p));
}

function minimalHostEnv(env: Record<string, string> | undefined): Record<string, string> {
  const base: Record<string, string> = {};
  const dotenvKeys = new Set((process.env.ETHOS_DOTENV_KEYS ?? '').split(',').filter(Boolean));
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined && isPassthroughEnvKey(key, dotenvKeys)) base[key] = val;
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

/**
 * A signal that is already aborted refuses BEFORE bash is spawned (V-ES-6), so
 * none of the command's side effects start — the rule execution-ssh follows.
 * Pinned by `__tests__/pre-aborted.test.ts`.
 */
function runLocal(cmd: string, opts: ExecOpts): AsyncIterable<ExecChunk> {
  if (opts.signal?.aborted) return refuseAborted();
  return streamChild(spawnLocal(cmd, opts), opts);
}

// biome-ignore lint/correctness/useYield: throws on first pull by design
async function* refuseAborted(): AsyncIterable<ExecChunk> {
  throw new ExecAbortedError();
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
    return runLocal(cmd, opts);
  }

  spawnSession(personalityId: string): ExecSession {
    return {
      personalityId,
      exec: (cmd: string, opts: ExecOpts = {}) => runLocal(cmd, opts),
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
