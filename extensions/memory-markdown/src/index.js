import { homedir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
// Files we look at on prefetch in a personality scope. Hard-coded to the
// two keys the old contract exposed; the file-keyed contract still lets
// tools-memory write arbitrary `.md` keys via sync().
const PERSONALITY_PREFETCH_KEYS = ['MEMORY.md', 'USER.md'];
/** Maximum size in bytes for any single memory key's content. */
const MAX_MEMORY_BYTES = 512 * 1024; // 512KB per key
export class MarkdownFileMemoryProvider {
    dir;
    storage;
    constructor(config = {}) {
        this.dir = config.dir ?? join(homedir(), '.ethos');
        this.storage = config.storage ?? new FsStorage();
    }
    // ---------------------------------------------------------------------------
    // Scope routing
    // ---------------------------------------------------------------------------
    /**
     * Resolve the storage directory for the given scope.
     *
     * | Prefix | Directory |
     * |---|---|
     * | `personality:<id>` | `<root>/personalities/<id>/` |
     * | `team:<id>` | `<root>/` (team provider is already scoped) |
     * | `user:<userId>` | `<root>/users/<userId>/` |
     *
     * Unrecognised or unsafe scope ids throw.
     */
    resolveScopeDir(ctx) {
        if (ctx.scopeId.startsWith('personality:')) {
            const id = ctx.scopeId.slice('personality:'.length);
            if (!id || !isSafePersonalityId(id)) {
                throw new Error(`unrecognised memory scope: ${ctx.scopeId}`);
            }
            return join(this.dir, 'personalities', id);
        }
        if (ctx.scopeId.startsWith('team:')) {
            const id = ctx.scopeId.slice('team:'.length);
            if (!id || !isSafePersonalityId(id)) {
                throw new Error(`unrecognised memory scope: ${ctx.scopeId}`);
            }
            return this.dir;
        }
        if (ctx.scopeId.startsWith('user:')) {
            const id = ctx.scopeId.slice('user:'.length);
            if (!id || !isSafePersonalityId(id)) {
                throw new Error(`unrecognised memory scope: ${ctx.scopeId}`);
            }
            return join(this.dir, 'users', id);
        }
        throw new Error(`unrecognised memory scope: ${ctx.scopeId}`);
    }
    /**
     * Map (scope, key) → absolute file path. All keys are stored within the
     * scope directory.
     */
    resolveKeyPath(key, ctx) {
        const scopeDir = this.resolveScopeDir(ctx);
        return join(scopeDir, key);
    }
    // ---------------------------------------------------------------------------
    // MemoryProvider — five-method contract
    // ---------------------------------------------------------------------------
    async prefetch(ctx) {
        const entries = [];
        for (const key of PERSONALITY_PREFETCH_KEYS) {
            const path = this.resolveKeyPath(key, ctx);
            const content = await this.storage.read(path);
            if (content && content.trim().length > 0) {
                entries.push({ key, content });
            }
        }
        if (entries.length === 0)
            return null;
        return { entries };
    }
    async read(key, ctx) {
        if (!isSafeKey(key))
            return null;
        const path = this.resolveKeyPath(key, ctx);
        const content = await this.storage.read(path);
        if (content === null)
            return null;
        const mtime = await this.storage.mtime(path);
        const entry = { key, content };
        if (mtime !== null)
            entry.metadata = { lastUpdatedAt: mtime };
        return entry;
    }
    async search(query, ctx, opts) {
        if (opts?.mode === 'semantic')
            return [];
        const trimmed = query.trim();
        if (!trimmed)
            return [];
        const refs = await this.list(ctx);
        const needle = trimmed.toLowerCase();
        const limit = opts?.limit ?? refs.length;
        const matches = [];
        for (const ref of refs) {
            if (matches.length >= limit)
                break;
            const entry = await this.read(ref.key, ctx);
            if (!entry)
                continue;
            if (entry.content.toLowerCase().includes(needle)) {
                matches.push(entry);
            }
        }
        return matches;
    }
    async sync(updates, ctx) {
        if (updates.length === 0)
            return;
        // Pre-create directories for any update that targets the scope dir or
        // shared root. Cheap and idempotent — mkdir on an existing dir is a no-op.
        const scopeDir = this.resolveScopeDir(ctx);
        await this.storage.mkdir(scopeDir);
        if (scopeDir !== this.dir)
            await this.storage.mkdir(this.dir);
        // Order contract: updates are ordered *within* each key (so an LLM
        // batching `add` then `remove` on MEMORY.md sees a deterministic
        // outcome), but cross-key order is NOT preserved — distinct files are
        // applied concurrently. Callers that need cross-key ordering must
        // issue separate sync() calls. Documented here so a future maintainer
        // doesn't discover the rule by debugging a flaky test.
        const byKey = new Map();
        for (const u of updates) {
            if (!isSafeKey(u.key))
                continue;
            const list = byKey.get(u.key) ?? [];
            list.push(u);
            byKey.set(u.key, list);
        }
        await Promise.all([...byKey.entries()].map(([key, group]) => this.applyUpdates(this.resolveKeyPath(key, ctx), group)));
    }
    async list(ctx, opts) {
        const scopeDir = this.resolveScopeDir(ctx);
        const refs = [];
        // Enumerate .md files in the scope dir. Storage.list returns an empty
        // array when the directory doesn't exist, so no try/catch is needed.
        const names = await this.storage.list(scopeDir);
        for (const name of names) {
            if (!name.endsWith('.md'))
                continue;
            if (!isSafeKey(name))
                continue;
            const path = join(scopeDir, name);
            const content = await this.storage.read(path);
            if (content === null)
                continue;
            const ref = { key: name };
            const mtime = await this.storage.mtime(path);
            if (mtime !== null)
                ref.metadata = { lastUpdatedAt: mtime };
            if (opts?.withSummaries) {
                const summary = firstParagraph(content);
                if (summary)
                    ref.summary = summary;
            }
            refs.push(ref);
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
    async readGlobalEntry(store) {
        const path = this.globalPath(store);
        const content = (await this.storage.read(path)) ?? '';
        const mtime = await this.storage.mtime(path);
        return {
            content,
            path,
            modifiedAt: mtime !== null ? new Date(mtime).toISOString() : null,
        };
    }
    async writeGlobalEntry(store, content) {
        await this.storage.mkdir(this.dir);
        const path = this.globalPath(store);
        await this.storage.write(path, content);
        return this.readGlobalEntry(store);
    }
    globalPath(store) {
        return join(this.dir, store === 'memory' ? 'MEMORY.md' : 'USER.md');
    }
    // ---------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------
    async applyUpdates(filePath, updates) {
        // Last operation wins within a key: a 'delete' followed by an 'add'
        // results in the file containing the added content, not an empty file.
        let content = (await this.storage.read(filePath)) ?? '';
        let deleted = false;
        for (const update of updates) {
            switch (update.action) {
                case 'add': {
                    content = content
                        ? `${content.trimEnd()}\n\n${update.content.trim()}\n`
                        : `${update.content.trim()}\n`;
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
                    if (!match)
                        break;
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
        if (content.length > MAX_MEMORY_BYTES) {
            // Trim from the beginning, preserving the most recent content
            const trimmed = content.slice(content.length - MAX_MEMORY_BYTES);
            // Find the first complete line break to avoid cutting mid-line
            const firstNewline = trimmed.indexOf('\n');
            content = firstNewline > 0 ? trimmed.slice(firstNewline + 1) : trimmed;
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
function isSafePersonalityId(id) {
    return /^[a-zA-Z0-9_-]+$/.test(id);
}
// Keys are user-visible file names within the scope dir. Lock down to a
// conservative charset so a tool argument can never write outside the dir.
function isSafeKey(key) {
    return /^[a-zA-Z0-9_.-]+$/.test(key) && !key.includes('..') && !key.startsWith('.');
}
function firstParagraph(text) {
    const para = text
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .find((p) => p.length > 0);
    return para && para.length > 0 ? para : undefined;
}
