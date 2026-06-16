import type { PersonalityConfig } from './personality';

export type ExecChunk =
  | { stream: 'stdout' | 'stderr'; data: string }
  /**
   * Terminal chunk carrying the command's exit code. Emitted as the LAST chunk
   * of a naturally-completed exec stream (after all stdout/stderr). Backends do
   * NOT emit it when the stream ends via timeout/abort — those throw instead.
   * Consumers that ignore exit codes can skip this variant (`data` is absent).
   */
  | { stream: 'exit'; code: number };

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  signal?: AbortSignal;
  /**
   * Personality whose `fs_reach` derives the container mount set (docker
   * backend). Routed execution tools pass this so the OS-layer mount boundary
   * matches the personality's declared reach. Ignored by `local`/`ssh`.
   */
  personality?: PersonalityConfig;
  /**
   * Session lane key. The lifecycle manager (SessionManager) keys persistent
   * exec sessions by (personality.id, sessionId). When absent, all execs for a
   * personality share a single default lane (sessionId defaults to '').
   */
  sessionId?: string;
}

export interface ExecSession {
  readonly personalityId: string;
  exec(cmd: string, opts?: ExecOpts): AsyncIterable<ExecChunk>;
  /**
   * Signal the in-session process(es). For the docker backend this signals the
   * containerized process (the boundary owns the real pid; the host never sees
   * it). Optional: backends without a real in-session pid (local/ssh thin
   * sessions) may omit it, in which case callers fall back to `dispose()`.
   */
  stop?(signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  dispose(): Promise<void>;
}

export interface MountSpec {
  hostPath: string;
  containerPath: string;
  mode: 'ro' | 'rw';
}

export interface ExecutionBackend {
  readonly name: string; // 'local' | 'docker' | 'ssh'
  isAvailable(): Promise<boolean>;
  exec(cmd: string, opts: ExecOpts): AsyncIterable<ExecChunk>;
  spawnSession(personalityId: string): ExecSession;
  mountsFor(p: PersonalityConfig): MountSpec[];
  dispose(): Promise<void>;
}

export interface ExecutionBackendConfig {
  /** Runtime image refs pinned by @sha256: digest (review #2). Keyed by logical runtime name. */
  images?: Record<string, string>;
  /** Default container memory cap in MB (docker). */
  memoryMb?: number;
  /** ssh target — remote-host trust, NOT mount-confinement (review A3). */
  ssh?: { host: string; user?: string; port?: number; identityFile?: string };
  /**
   * Substitution roots for resolving `${ETHOS_HOME}` and `${CWD}` in
   * `fs_reach` before deriving mounts. `${self}` resolves to the personality
   * id at `mountsFor` time. When absent, the docker backend falls back to
   * `~/.ethos` and `process.cwd()`.
   */
  substitutionVars?: { ethosHome: string; cwd: string };
}

export type ExecutionBackendFactory = (ctx: {
  config: ExecutionBackendConfig;
  secrets: import('./secrets').SecretsResolver;
  logger: import('./logger').Logger;
}) => ExecutionBackend | Promise<ExecutionBackend>;

export interface ExecutionBackendRegistry {
  register(name: string, factory: ExecutionBackendFactory): void;
  /** Resolve (and cache) a registered factory into a concrete backend instance. */
  resolve(
    name: string,
    ctx: {
      config: ExecutionBackendConfig;
      secrets: import('./secrets').SecretsResolver;
      logger: import('./logger').Logger;
    },
  ): Promise<ExecutionBackend>;
  get(name: string): ExecutionBackend | undefined;
  list(): string[];
}
