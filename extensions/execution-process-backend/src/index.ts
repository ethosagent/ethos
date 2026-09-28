import { type ChildProcess, spawn } from 'node:child_process';
import type { EthosPlugin, EthosPluginApi, ExecutionBackendFactory } from '@ethosagent/plugin-sdk';
import type {
  ExecChunk,
  ExecOpts,
  ExecSession,
  ExecutionBackend,
  MountSpec,
  PersonalityConfig,
  SandboxAttestation,
} from '@ethosagent/types';

/**
 * Host env vars the command inherits (V-ES-7). The full `process.env` carries
 * provider keys, bot tokens and every `~/.ethos/.env` entry, so only the
 * minimum a shell and common toolchains need is forwarded and the caller's
 * explicit `env` is layered on top.
 *
 * The same allowlist as `packages/core/src/scoped/scoped-process.ts`,
 * `extensions/tools-process/src/spawn.ts` and
 * `extensions/execution-local/src/index.ts`, copied because this package
 * depends only on `@ethosagent/types` and the plugin SDK. The four change
 * together. Pinned by `__tests__/process-backend.test.ts`.
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
 * pid is the group id), so grandchildren a command started die with it.
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
 * from a spawned child process. The same lifetime rules as `streamChild` in
 * `extensions/execution-local/src/index.ts` (copied, not shared — each
 * execution package has zero cross-package coupling): completes on the
 * child's exit plus a bounded drain ({@link EXIT_DRAIN_MS}), never on `close`
 * alone; a timeout, an abort, or a consumer that stops iterating early stops
 * the whole group ({@link stopGroup}). Pinned by `__tests__/process-backend.test.ts`.
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
    error = new Error('Execution timed out');
    stopGroup(child);
    done = true;
    resolveNext?.();
  }, timeoutMs);

  const signal = opts.signal;
  const onAbort = () => {
    error = new Error('Execution aborted');
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

// biome-ignore lint/correctness/useYield: throws on first pull by design
async function* refuseAborted(): AsyncIterable<ExecChunk> {
  throw new Error('Execution aborted');
}

/**
 * Process execution backend — spawns child processes directly on the host.
 * NOT sandboxed. Honest attestation: all confinement booleans are false except
 * noDockerSocket (no docker socket is involved in process spawning).
 *
 * This is a reference plugin backend that proves the ExecutionBackend plugin
 * seam works end-to-end via `registerExecutionBackend`.
 */
class ProcessExecutionBackend implements ExecutionBackend {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  exec(cmd: string, opts: ExecOpts): AsyncIterable<ExecChunk> {
    // A signal that is already aborted refuses BEFORE bash is spawned, so
    // none of the command's side effects start (as execution-local/-ssh do).
    if (opts.signal?.aborted) return refuseAborted();
    const child = spawn('bash', ['-c', cmd], {
      cwd: opts.cwd,
      env: minimalHostEnv(opts.env),
      detached: USE_PROCESS_GROUP,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return streamChild(child, opts);
  }

  spawnSession(personalityId: string): ExecSession {
    return {
      personalityId,
      exec: (cmd: string, opts: ExecOpts = {}) => this.exec(cmd, opts),
      dispose: () => Promise.resolve(),
    };
  }

  mountsFor(_p: PersonalityConfig): MountSpec[] {
    // Process backend runs on the host — no mount confinement.
    return [];
  }

  attest(): SandboxAttestation {
    // Honest partial attestation — process execution is NOT sandboxed.
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

const factory: ExecutionBackendFactory = ({
  config: _config,
  secrets: _secrets,
  logger: _logger,
}) => {
  return new ProcessExecutionBackend('process');
};

const plugin: EthosPlugin = {
  activate(api: EthosPluginApi) {
    api.registerExecutionBackend('process', factory);
  },
};

export default plugin;
