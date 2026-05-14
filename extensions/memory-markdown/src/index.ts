import { homedir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type {
  GlobalMemoryEntry,
  ListOpts,
  MemoryContext,
  MemoryEntry,
  MemoryEntryRef,
  MemoryProvider,
  MemorySnapshot,
  MemoryUpdate,
  SearchOpts,
  Storage,
} from '@ethosagent/types';

// Files we look at on prefetch in a personality scope. Hard-coded to the
// two keys the old contract exposed; the file-keyed contract still lets
// tools-memory write arbitrary `.md` keys via sync().
const PERSONALITY_PREFETCH_KEYS = ['MEMORY.md', 'USER.md'] as const;

export interface MarkdownMemoryConfig {
  /** Directory containing MEMORY.md and USER.md. Defaults to ~/.ethos */
  dir?: string;
  /** Storage backend. Defaults to FsStorage. Inject InMemoryStorage in tests. */
  storage?: Storage;
}

export class MarkdownFileMemoryProvider implements MemoryProvider {
  private readonly dir: string;
  private readonly storage: Storage;

  constructor(config: MarkdownMemoryConfig = {}) {
    this.dir = config.dir ?? join(homedir(), '.ethos');
    this.storage = config.storage ?? new FsStorage();
  }

  // ---------------------------------------------------------------------------
  // Scope routing
  // ---------------------------------------------------------------------------

  /**
   * Resolve the directory MEMORY.md (and other per-personality keys) live in
   * for this turn. `personality:<id>` → `<root>/personalities/<id>/`.
   * Anything else (or an unsafe id) falls back to the shared root.
   *
   * Note: USER.md is special-cased in `resolveKeyPath`; it always lives in
   * the shared root regardless of scope, because it describes the human,
   * not the agent.
   */
  private resolveScopeDir(ctx: MemoryContext): string {
    const prefix = 'personality:';
    if (!ctx.scopeId.startsWith(prefix)) return this.dir;
    const id = ctx.scopeId.slice(prefix.length);
    if (!id || !isSafePersonalityId(id)) return this.dir;
    return join(this.dir, 'personalities', id);
  }

  /**
   * Map (scope, key) → absolute file path. USER.md is the one shared-root
   * exception; every other key is treated as a regular `.md` file within
   * the scope dir.
   */
  private resolveKeyPath(key: string, ctx: MemoryContext): string {
    if (key === 'USER.md') return join(this.dir, 'USER.md');
    const scopeDir = this.resolveScopeDir(ctx);
    return join(scopeDir, key);
  }

  // ---------------------------------------------------------------------------
  // MemoryProvider — five-method contract
  // ---------------------------------------------------------------------------

  async prefetch(ctx: MemoryContext): Promise<MemorySnapshot | null> {
    const entries: Array<{ key: string; content: string }> = [];
    for (const key of PERSONALITY_PREFETCH_KEYS) {
      const path = this.resolveKeyPath(key, ctx);
      const content = await this.storage.read(path);
      if (content && content.trim().length > 0) {
        entries.push({ key, content });
      }
    }
    if (entries.length === 0) return null;
    return { entries };
  }

  async read(key: string, ctx: MemoryContext): Promise<MemoryEntry | null> {
    if (!isSafeKey(key)) return null;
    const path = this.resolveKeyPath(key, ctx);
    const content = await this.storage.read(path);
    if (content === null) return null;
    const mtime = await this.storage.mtime(path);
    const entry: MemoryEntry = { key, content };
    if (mtime !== null) entry.metadata = { lastUpdatedAt: mtime };
    return entry;
  }

  async search(query: string, ctx: MemoryContext, opts?: SearchOpts): Promise<MemoryEntry[]> {
    if (opts?.mode === 'semantic') return [];
    const trimmed = query.trim();
    if (!trimmed) return [];

    const refs = await this.list(ctx);
    const needle = trimmed.toLowerCase();
    const limit = opts?.limit ?? refs.length;
    const matches: MemoryEntry[] = [];
    for (const ref of refs) {
      if (matches.length >= limit) break;
      const entry = await this.read(ref.key, ctx);
      if (!entry) continue;
      if (entry.content.toLowerCase().includes(needle)) {
        matches.push(entry);
      }
    }
    return matches;
  }

  async sync(updates: MemoryUpdate[], ctx: MemoryContext): Promise<void> {
    if (updates.length === 0) return;

    // Pre-create directories for any update that targets the scope dir or
    // shared root. Cheap and idempotent — mkdir on an existing dir is a no-op.
    const scopeDir = this.resolveScopeDir(ctx);
    await this.storage.mkdir(scopeDir);
    if (scopeDir !== this.dir) await this.storage.mkdir(this.dir);

    // Order contract: updates are ordered *within* each key (so an LLM
    // batching `add` then `remove` on MEMORY.md sees a deterministic
    // outcome), but cross-key order is NOT preserved — distinct files are
    // applied concurrently. Callers that need cross-key ordering must
    // issue separate sync() calls. Documented here so a future maintainer
    // doesn't discover the rule by debugging a flaky test.
    const byKey = new Map<string, MemoryUpdate[]>();
    for (const u of updates) {
      if (!isSafeKey(u.key)) continue;
      const list = byKey.get(u.key) ?? [];
      list.push(u);
      byKey.set(u.key, list);
    }

    await Promise.all(
      [...byKey.entries()].map(([key, group]) =>
        this.applyUpdates(this.resolveKeyPath(key, ctx), group),
      ),
    );
  }

  async list(ctx: MemoryContext, opts?: ListOpts): Promise<MemoryEntryRef[]> {
    const scopeDir = this.resolveScopeDir(ctx);
    const refs: MemoryEntryRef[] = [];

    const seen = new Set<string>();
    // Always include the shared USER.md when it exists, even when the
    // scope dir differs (USER.md is the one cross-scope key).
    const sharedUserPath = join(this.dir, 'USER.md');
    const sharedUserContent = await this.storage.read(sharedUserPath);
    if (sharedUserContent !== null) {
      seen.add('USER.md');
      const ref: MemoryEntryRef = { key: 'USER.md' };
      const mtime = await this.storage.mtime(sharedUserPath);
      if (mtime !== null) ref.metadata = { lastUpdatedAt: mtime };
      if (opts?.withSummaries) {
        const summary = firstParagraph(sharedUserContent);
        if (summary) ref.summary = summary;
      }
      refs.push(ref);
    }

    // Enumerate .md files in the scope dir. Storage.list returns an empty
    // array when the directory doesn't exist, so no try/catch is needed.
    const names = await this.storage.list(scopeDir);
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      if (seen.has(name)) continue;
      if (!isSafeKey(name)) continue;
      const path = join(scopeDir, name);
      const content = await this.storage.read(path);
      if (content === null) continue;
      const ref: MemoryEntryRef = { key: name };
      const mtime = await this.storage.mtime(path);
      if (mtime !== null) ref.metadata = { lastUpdatedAt: mtime };
      if (opts?.withSummaries) {
        const summary = firstParagraph(content);
        if (summary) ref.summary = summary;
      }
      refs.push(ref);
      seen.add(name);
    }

    if (opts?.limit !== undefined && refs.length > opts.limit) {
      return refs.slice(0, opts.limit);
    }
    return refs;
  }

  // ---------------------------------------------------------------------------
  // GlobalMemoryStore — narrow editor capability for the web Memory tab
  // ---------------------------------------------------------------------------
  //
  // Implements GlobalMemoryStore from @ethosagent/types. Returns content plus
  // the on-disk path (the markdown backend has one; other backends can return
  // null per the contract) and the file's modification time as ISO-8601.

  async readGlobalEntry(store: 'memory' | 'user'): Promise<GlobalMemoryEntry> {
    const path = this.globalPath(store);
    const content = (await this.storage.read(path)) ?? '';
    const mtime = await this.storage.mtime(path);
    return {
      content,
      path,
      modifiedAt: mtime !== null ? new Date(mtime).toISOString() : null,
    };
  }

  async writeGlobalEntry(store: 'memory' | 'user', content: string): Promise<GlobalMemoryEntry> {
    await this.storage.mkdir(this.dir);
    const path = this.globalPath(store);
    await this.storage.write(path, content);
    return this.readGlobalEntry(store);
  }

  private globalPath(store: 'memory' | 'user'): string {
    return join(this.dir, store === 'memory' ? 'MEMORY.md' : 'USER.md');
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async applyUpdates(filePath: string, updates: MemoryUpdate[]): Promise<void> {
    // Last operation wins within a key: a 'delete' followed by an 'add'
    // results in the file containing the added content, not an empty file.
    let content = (await this.storage.read(filePath)) ?? '';
    let deleted = false;

    for (const update of updates) {
      switch (update.action) {
        case 'add':
          content = content
            ? `${content.trimEnd()}\n\n${update.content.trim()}\n`
            : `${update.content.trim()}\n`;
          deleted = false;
          break;

        case 'replace':
          content = `${update.content.trim()}\n`;
          deleted = false;
          break;

        case 'remove': {
          const match = update.substringMatch;
          if (!match) break;
          const lines = content.split('\n');
          content = `${lines
            .filter((line) => !line.includes(match))
            .join('\n')
            .trimEnd()}\n`;
          deleted = false;
          break;
        }

        case 'delete':
          deleted = true;
          content = '';
          break;
      }
    }

    if (deleted) {
      // Best-effort: a missing file is fine; remove() throws on other errors.
      if (await this.storage.exists(filePath)) {
        await this.storage.remove(filePath);
      }
      return;
    }

    await this.storage.write(filePath, content);
  }
}

// Reject ids with path separators, parent traversal, leading dots, or anything
// outside [a-zA-Z0-9_-]. Belt-and-suspenders — the personality loader uses
// directory names which are already constrained, but this is a security
// boundary we don't want to depend on a caller upholding.
function isSafePersonalityId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

// Keys are user-visible file names within the scope dir. Lock down to a
// conservative charset so a tool argument can never write outside the dir.
function isSafeKey(key: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(key) && !key.includes('..') && !key.startsWith('.');
}

function firstParagraph(text: string): string | undefined {
  const para = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0);
  return para && para.length > 0 ? para : undefined;
}
