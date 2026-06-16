import type { PersonalityConfig } from './personality';

export interface ExecChunk {
  stream: 'stdout' | 'stderr';
  data: string;
}

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
}

export interface ExecSession {
  readonly personalityId: string;
  exec(cmd: string, opts?: ExecOpts): AsyncIterable<ExecChunk>;
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
