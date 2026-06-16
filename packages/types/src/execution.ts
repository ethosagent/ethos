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
}

export type ExecutionBackendFactory = (ctx: {
  config: ExecutionBackendConfig;
  secrets: import('./secrets').SecretsResolver;
  logger: import('./logger').Logger;
}) => ExecutionBackend | Promise<ExecutionBackend>;

export interface ExecutionBackendRegistry {
  register(name: string, factory: ExecutionBackendFactory): void;
  get(name: string): ExecutionBackend | undefined;
  list(): string[];
}
