// Memory subsystem — five-method MemoryProvider contract.
//
// A memory provider is keyed by `key` strings within an opaque `scopeId`.
// The scope is intentionally opaque so providers don't depend on Ethos
// concepts like personalities; callers stamp the scope ("personality:<id>"
// or "team:<id>") and the provider routes storage accordingly.
//
// The contract is FROZEN at five methods. Adding a sixth requires the
// memory-method-count gate in __tests__/memory-method-count.test.ts to be
// bumped in the same commit (mirrors PersonalityConfig's field-count
// gate). The number is a load-bearing schema discipline, not a spec.

export interface MemoryContext {
  /** Opaque scope id. Conventional prefixes: `personality:<id>`, `team:<id>`. */
  scopeId: string;
  sessionId: string;
  sessionKey: string;
  platform: string;
  workingDir: string;
}

export interface MemorySnapshot {
  entries: Array<{ key: string; content: string }>;
}

export interface MemoryEntry {
  key: string;
  content: string;
  metadata?: {
    lastUpdatedAt?: number;
    lastUpdatedBy?: string;
  };
}

export interface MemoryEntryRef {
  key: string;
  summary?: string;
  metadata?: { lastUpdatedAt?: number };
}

export type MemoryUpdate =
  | { action: 'add'; key: string; content: string }
  | { action: 'replace'; key: string; content: string }
  | { action: 'remove'; key: string; substringMatch: string }
  | { action: 'delete'; key: string };

export interface SearchOpts {
  limit?: number;
  mode?: 'keyword' | 'semantic' | 'hybrid';
}

export interface ListOpts {
  limit?: number;
  withSummaries?: boolean;
}

export interface MemoryProvider {
  prefetch(ctx: MemoryContext): Promise<MemorySnapshot | null>;
  read(key: string, ctx: MemoryContext): Promise<MemoryEntry | null>;
  search(query: string, ctx: MemoryContext, opts?: SearchOpts): Promise<MemoryEntry[]>;
  /**
   * Order contract: updates are applied in input order *within each
   * `key`*. Updates across distinct keys may be applied concurrently —
   * cross-key ordering is NOT guaranteed. Callers that need a strict
   * cross-key ordering must issue separate `sync()` calls.
   */
  sync(updates: MemoryUpdate[], ctx: MemoryContext): Promise<void>;
  list(ctx: MemoryContext, opts?: ListOpts): Promise<MemoryEntryRef[]>;
}

// ---------------------------------------------------------------------------
// Memory Provider Registry — pluggable memory backend factories
// ---------------------------------------------------------------------------

export interface MemoryProviderFactoryContext {
  config: Record<string, unknown>;
  dataDir: string;
  secrets: import('./secrets').SecretsResolver;
  logger: import('./logger').Logger;
}

export type MemoryProviderFactory = (
  ctx: MemoryProviderFactoryContext,
) => MemoryProvider | Promise<MemoryProvider>;

export interface MemoryProviderRegistry {
  register(name: string, factory: MemoryProviderFactory): void;
  unregister(name: string): void;
  get(name: string): MemoryProviderFactory | undefined;
  list(): string[];
}

/**
 * Direct-access capability for the global memory stores (`memory` and
 * `user`). Surfaces that ship a memory editor (the web-api Memory tab)
 * depend on this narrow shape rather than on a concrete provider class.
 *
 * Backend-neutral by design: `path` is nullable so backends without an
 * addressable on-disk location (DB, remote, encrypted) return null. The
 * web UI conditionally surfaces the path when present and treats it as
 * an affordance, not a contract.
 */
export interface GlobalMemoryStore {
  readGlobalEntry(store: 'memory' | 'user'): Promise<GlobalMemoryEntry>;
  writeGlobalEntry(store: 'memory' | 'user', content: string): Promise<GlobalMemoryEntry>;
}

export interface GlobalMemoryEntry {
  content: string;
  /** Backend-local address if it has one (file path, URL, opaque id); null otherwise. */
  path: string | null;
  modifiedAt: string | null;
}
