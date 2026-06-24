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
 * Queue-backed async generator that streams interleaved stdout/stderr chunks
 * from a spawned child process.
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
    error = new Error('Execution timed out');
    child.kill();
    done = true;
    resolveNext?.();
  }, timeoutMs);

  const signal = opts.signal;
  if (signal) {
    if (signal.aborted) {
      error = new Error('Execution aborted');
      done = true;
    } else {
      signal.addEventListener(
        'abort',
        () => {
          error = new Error('Execution aborted');
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
    const child = spawn('bash', ['-c', cmd], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
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
