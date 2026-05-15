export type SecretRef = string;

export type StorageScope = 'tool-private' | 'session' | 'personality';

export interface ToolCapabilities {
  network?: {
    allowedHosts: string[];
  };
  secrets?: SecretRef[];
  storage?: {
    scope: StorageScope;
    kind: 'kv';
    ttlSecondsDefault?: number;
  };
  fs_reach?: {
    read?: string[] | 'from-personality';
    write?: string[] | 'from-personality';
  };
  process?: {
    allowedBinaries: string[];
  };
}

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface ScopedSecretsResolver {
  get(ref: SecretRef): Promise<string>;
}

export interface ScopedFetch {
  fetch(url: string | URL, init?: RequestInit): Promise<Response>;
}

export interface ScopedFs {
  read(path: string): Promise<string>;
  write(path: string, content: string | Buffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<string[]>;
}

export interface SpawnOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ScopedProcess {
  spawn(binary: string, args: string[], opts?: SpawnOpts): Promise<ProcessResult>;
}
