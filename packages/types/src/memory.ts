export interface MemoryContext {
  content: string;
  source: 'markdown' | 'vector' | 'honcho' | 'custom';
  truncated: boolean;
}

export interface MemoryLoadContext {
  sessionId: string;
  sessionKey: string;
  userId?: string;
  platform: string;
  workingDir?: string;
  personalityId?: string;
  /**
   * Resolved memory scope for the active personality. Providers that support
   * scoping (e.g. MarkdownFileMemoryProvider) route 'per-personality' writes
   * into a personality-isolated path; 'global' (or undefined) writes to the
   * shared root. AgentLoop fills this from the resolved personality.
   */
  memoryScope?: 'global' | 'per-personality';
  /** Current user message — used by VectorMemoryProvider for semantic retrieval */
  query?: string;
}

export type MemoryStore = 'memory' | 'user';

export interface MemoryUpdate {
  store: MemoryStore;
  action: 'add' | 'replace' | 'remove';
  content: string;
  substringMatch?: string;
}

export interface MemoryProvider {
  prefetch(ctx: MemoryLoadContext): Promise<MemoryContext | null>;
  sync(ctx: MemoryLoadContext, updates: MemoryUpdate[]): Promise<void>;
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
  readGlobalEntry(store: MemoryStore): Promise<GlobalMemoryEntry>;
  writeGlobalEntry(store: MemoryStore, content: string): Promise<GlobalMemoryEntry>;
}

export interface GlobalMemoryEntry {
  content: string;
  /** Backend-local address if it has one (file path, URL, opaque id); null otherwise. */
  path: string | null;
  modifiedAt: string | null;
}
