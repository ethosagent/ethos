import type { Attachment } from './platform';

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
  attachments?: {
    kinds: ('image' | 'file')[] | '*';
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

/** Direct shape match for `Storage.listEntries` entries — duplicated here
 *  rather than imported to keep `tool-capabilities.ts` free of cross-file
 *  imports. The duplication is one struct; the alternative is a cycle. */
export interface ScopedFsEntry {
  name: string;
  isDir: boolean;
}

export interface ScopedFs {
  read(path: string): Promise<string>;
  /**
   * Read a file as raw bytes. Throws when the path is outside the personality
   * read allowlist or the file does not exist. Distinct from `read` because
   * UTF-8 decoding mangles binary payloads (JPEG / PNG / PDF magic bytes are
   * not valid UTF-8). Use for attachments and any non-text blob.
   */
  readBytes(path: string): Promise<Uint8Array>;
  write(path: string, content: string | Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<string[]>;

  /** Modification time in epoch-ms; null when the path does not exist.
   *  Required for the stale-write guard used by tools that write files
   *  read earlier in the same turn. */
  mtime(path: string): Promise<number | null>;

  /** Create a directory and parents. No-op when already a directory.
   *  Reach-checked against the write allowlist. */
  mkdir(dir: string): Promise<void>;

  /** List immediate children with type info; empty array when the
   *  directory does not exist. Reach-checked against the read allowlist. */
  listEntries(dir: string): Promise<ScopedFsEntry[]>;
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

export interface ScopedAttachments {
  list(): Attachment[];
  open(att: Attachment): Promise<{ path: string }>;
  openByRef(ref: string): Promise<{ path: string }>;
}
