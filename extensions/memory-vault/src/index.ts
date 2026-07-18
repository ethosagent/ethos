import { basename, dirname, join, relative } from 'node:path';
import type {
  GlobalMemoryEntry,
  ListOpts,
  Logger,
  MemoryContext,
  MemoryEntry,
  MemoryEntryRef,
  MemoryProvider,
  MemorySnapshot,
  MemoryUpdate,
  SearchOpts,
  Storage,
} from '@ethosagent/types';

// Default keys prefetched into the prompt tail for a personality scope.
// Overridable via `prefetchKeys` — a bring-your-own-vault user may name the
// two rolling files whatever their vault convention is.
const DEFAULT_PREFETCH_KEYS = ['MEMORY.md', 'USER.md'] as const;

// Subtree under the vault root the agent owns. Every scope routes beneath it;
// the ScopedStorage write allowlist is confined to this subtree so the memory
// system can never write outside the folder it was given.
const DEFAULT_AGENT_DIR = 'Ethos';

/** Maximum size in bytes for any single memory key's content. */
const MAX_MEMORY_BYTES = 512 * 1024; // 512KB per key

/** Cap on files inspected by a single `search()` walk — keeps a large vault bounded. */
const MAX_SEARCH_FILES = 1000;

export interface VaultMemoryConfig {
  /** Absolute path to the vault root (the Obsidian folder). */
  vaultRoot: string;
  /**
   * Subtree under `vaultRoot` the agent owns; scopes route beneath it and all
   * writes are confined to it. Defaults to `Ethos`.
   */
  agentDir?: string;
  /**
   * Keys prefetched into the prompt tail for a personality scope. Defaults to
   * `['MEMORY.md', 'USER.md']`.
   */
  prefetchKeys?: string[];
  /**
   * Directory / file names never read during `list()` / `search()` (in
   * addition to dot-directories and Obsidian sync-conflict files, which are
   * always excluded).
   */
  exclude?: string[];
  /**
   * Storage backend. Injected by wiring (composition root) — in production a
   * `FsStorage` wrapped in `ScopedStorage` rooted at the vault. Inject
   * `InMemoryStorage` in tests. Required; never falls back to raw disk.
   */
  storage: Storage;
  /** Optional logger used to surface stale-write skips. */
  logger?: Logger;
}

/**
 * MemoryProvider over a user-owned external directory (an Obsidian-style
 * vault). Mirrors the markdown backend's scope routing but roots everything
 * under `<vaultRoot>/<agentDir>` for writes, while `search()` may read across
 * the whole vault. The headline correctness property is the stale-write
 * guard: a `sync()` never clobbers a file a concurrent editor (Obsidian,
 * iCloud) touched between the pre-sync read and the write.
 */
export class VaultMemoryProvider implements MemoryProvider {
  private readonly vaultRoot: string;
  private readonly agentRoot: string;
  private readonly prefetchKeys: string[];
  private readonly exclude: Set<string>;
  private readonly storage: Storage;
  private readonly logger: Logger | undefined;

  constructor(config: VaultMemoryConfig) {
    this.vaultRoot = config.vaultRoot;
    this.agentRoot = join(config.vaultRoot, config.agentDir ?? DEFAULT_AGENT_DIR);
    this.prefetchKeys =
      config.prefetchKeys && config.prefetchKeys.length > 0
        ? config.prefetchKeys
        : [...DEFAULT_PREFETCH_KEYS];
    this.exclude = new Set(config.exclude ?? []);
    this.storage = config.storage;
    this.logger = config.logger;
  }

  // ---------------------------------------------------------------------------
  // Scope routing — rooted at the agent subtree, never the vault root.
  // ---------------------------------------------------------------------------

  private resolveScopeDir(ctx: MemoryContext): string {
    if (ctx.scopeId.startsWith('personality:')) {
      const id = ctx.scopeId.slice('personality:'.length);
      if (!id || !isSafeId(id)) throw new Error(`unrecognised memory scope: ${ctx.scopeId}`);
      return join(this.agentRoot, 'personalities', id);
    }
    if (ctx.scopeId.startsWith('team:')) {
      const id = ctx.scopeId.slice('team:'.length);
      if (!id || !isSafeId(id)) throw new Error(`unrecognised memory scope: ${ctx.scopeId}`);
      return this.agentRoot;
    }
    if (ctx.scopeId.startsWith('user:')) {
      const id = ctx.scopeId.slice('user:'.length);
      if (!id || !isSafeId(id)) throw new Error(`unrecognised memory scope: ${ctx.scopeId}`);
      return join(this.agentRoot, 'users', id);
    }
    throw new Error(`unrecognised memory scope: ${ctx.scopeId}`);
  }

  private resolveKeyPath(key: string, ctx: MemoryContext): string {
    return join(this.resolveScopeDir(ctx), key);
  }

  // ---------------------------------------------------------------------------
  // MemoryProvider — five-method contract
  // ---------------------------------------------------------------------------

  async prefetch(ctx: MemoryContext): Promise<MemorySnapshot | null> {
    const entries: Array<{ key: string; content: string }> = [];
    for (const key of this.prefetchKeys) {
      if (!isSafeKey(key)) continue;
      const content = await this.storage.read(this.resolveKeyPath(key, ctx));
      if (content && content.trim().length > 0) entries.push({ key, content });
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

  async search(query: string, _ctx: MemoryContext, opts?: SearchOpts): Promise<MemoryEntry[]> {
    // Semantic retrieval stays the vector backend's job — a vault indexer is
    // explicitly out of scope (heavy vector stores lose to editable markdown).
    if (opts?.mode === 'semantic') return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return [];

    const limit = opts?.limit ?? Number.POSITIVE_INFINITY;
    const matches: MemoryEntry[] = [];
    let scanned = 0;

    // Read across the whole vault (read allowlist is the vault root) so the
    // agent can find the user's notes. User-authored notes are untrusted; the
    // downstream prefetch/search sanitize path treats them as such.
    const stack: string[] = [this.vaultRoot];
    while (stack.length > 0 && matches.length < limit && scanned < MAX_SEARCH_FILES) {
      const dir = stack.pop();
      if (dir === undefined) break;
      const dirEntries = await this.storage.listEntries(dir);
      for (const child of dirEntries) {
        if (child.isDir) {
          if (child.name.startsWith('.') || this.exclude.has(child.name)) continue;
          stack.push(join(dir, child.name));
          continue;
        }
        if (matches.length >= limit || scanned >= MAX_SEARCH_FILES) break;
        if (!child.name.endsWith('.md')) continue;
        if (isConflictFile(child.name) || this.exclude.has(child.name)) continue;
        const path = join(dir, child.name);
        const content = await this.storage.read(path);
        scanned++;
        if (content === null) continue;
        if (content.toLowerCase().includes(needle)) {
          const mtime = await this.storage.mtime(path);
          const entry: MemoryEntry = { key: relative(this.vaultRoot, path), content };
          if (mtime !== null) entry.metadata = { lastUpdatedAt: mtime };
          matches.push(entry);
        }
      }
    }
    return matches;
  }

  async sync(updates: MemoryUpdate[], ctx: MemoryContext): Promise<void> {
    if (updates.length === 0) return;
    const scopeDir = this.resolveScopeDir(ctx);
    await this.storage.mkdir(scopeDir);

    // Order contract: updates are ordered within each key; distinct keys are
    // applied concurrently. Same rule as the markdown backend.
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
    const names = await this.storage.list(scopeDir);
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      if (!isSafeKey(name)) continue;
      if (isConflictFile(name) || this.exclude.has(name)) continue;
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
    }
    if (opts?.limit !== undefined && refs.length > opts.limit) return refs.slice(0, opts.limit);
    return refs;
  }

  // ---------------------------------------------------------------------------
  // GlobalMemoryStore — narrow editor capability for the web Memory tab.
  // The two rolling files live at the agent-subtree root.
  // ---------------------------------------------------------------------------

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
    await this.storage.mkdir(this.agentRoot);
    // An explicit human edit from the web editor — atomic, no stale guard:
    // the editor rendered the current content and the user chose to overwrite.
    await this.storage.writeAtomic(this.globalPath(store), content);
    return this.readGlobalEntry(store);
  }

  private globalPath(store: 'memory' | 'user'): string {
    return join(this.agentRoot, store === 'memory' ? 'MEMORY.md' : 'USER.md');
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async applyUpdates(filePath: string, updates: MemoryUpdate[]): Promise<void> {
    // Stale-write guard: capture mtime, then read the basis content. If the
    // file's mtime advances before we write, a concurrent editor (Obsidian /
    // iCloud) touched it — the basis is stale and an overwrite would clobber
    // their edit.
    const mtimeBefore = await this.storage.mtime(filePath);
    const content0 = (await this.storage.read(filePath)) ?? '';
    const { content, deleted } = reduceUpdates(content0, updates);

    const mtimeNow = await this.storage.mtime(filePath);
    const moved = mtimeBefore !== null && mtimeNow !== null && mtimeNow !== mtimeBefore;
    if (moved) {
      await this.applyStale(filePath, updates);
      return;
    }

    if (deleted) {
      if (await this.storage.exists(filePath)) await this.storage.remove(filePath);
      return;
    }

    const capped = await this.capAndArchive(filePath, content);
    // Atomic write: a partial write to a memory file corrupts it.
    await this.storage.writeAtomic(filePath, capped);
  }

  /**
   * Concurrent edit detected. Preserve the external changes: re-read the fresh
   * content and re-apply only the additive `add` updates onto it (appends
   * commute with a concurrent edit). Destructive updates (`replace` / `remove`
   * / `delete`) are skipped rather than clobbering the newer content, and the
   * skip is surfaced via the logger.
   */
  private async applyStale(filePath: string, updates: MemoryUpdate[]): Promise<void> {
    const fresh = (await this.storage.read(filePath)) ?? '';
    let merged = fresh;
    let appliedAdds = 0;
    let skippedDestructive = 0;
    for (const u of updates) {
      if (u.action === 'add') {
        merged = appendBlock(merged, u.content);
        appliedAdds++;
      } else {
        skippedDestructive++;
      }
    }
    if (merged !== fresh) {
      const capped = await this.capAndArchive(filePath, merged);
      await this.storage.writeAtomic(filePath, capped);
    }
    this.logger?.warn(
      'memory-vault: concurrent edit detected — preserved external changes, skipped destructive updates',
      { path: filePath, appliedAdds, skippedDestructive },
    );
  }

  /**
   * Enforce the per-key byte cap. Overflow is routed into `memory-archive.md`
   * in the same directory rather than silently dropped — the bytes survive.
   */
  private async capAndArchive(filePath: string, content: string): Promise<string> {
    if (content.length <= MAX_MEMORY_BYTES) return content;
    const trimmed = content.slice(content.length - MAX_MEMORY_BYTES);
    const firstNewline = trimmed.indexOf('\n');
    const kept = firstNewline > 0 ? trimmed.slice(firstNewline + 1) : trimmed;
    const dropped = content.slice(0, content.length - kept.length).trimEnd();
    if (dropped.length > 0) {
      const archivePath = join(dirname(filePath), 'memory-archive.md');
      const stamp = new Date().toISOString();
      await this.storage.append(
        archivePath,
        `\n<!-- overflow-archived ${stamp} from ${basename(filePath)} -->\n${dropped}\n`,
      );
    }
    return kept;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function reduceUpdates(
  content0: string,
  updates: MemoryUpdate[],
): { content: string; deleted: boolean } {
  let content = content0;
  let deleted = false;
  for (const update of updates) {
    switch (update.action) {
      case 'add': {
        content = appendBlock(content, update.content);
        deleted = false;
        break;
      }
      case 'replace': {
        content = `${update.content.trim()}\n`;
        deleted = false;
        break;
      }
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
      case 'delete': {
        deleted = true;
        content = '';
        break;
      }
    }
  }
  return { content, deleted };
}

function appendBlock(content: string, addition: string): string {
  const add = addition.trim();
  return content ? `${content.trimEnd()}\n\n${add}\n` : `${add}\n`;
}

// Obsidian Sync / iCloud / Syncthing / Dropbox conflict copies. Never read
// into prefetch or search, and hidden from list().
function isConflictFile(name: string): boolean {
  return (
    /\(conflict\)/i.test(name) || /\.sync-conflict/i.test(name) || /conflicted copy/i.test(name)
  );
}

// Reject ids with path separators, parent traversal, or anything outside
// [a-zA-Z0-9_-]. Belt-and-suspenders against a caller-supplied scope id.
function isSafeId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

// Keys are file names within the scope dir. Conservative charset so a tool
// argument can never write outside the dir.
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
