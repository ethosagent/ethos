// McpJsonStore — single writer for ~/.ethos/mcp.json.
//
// Both the CLI (`ethos mcp add`) and the SDK install flow used by the web-api
// mutate the same `mcp.json` file. The CLI used to call raw `node:fs.writeFileSync`
// while the SDK uses `storage.writeAtomic`; concurrent UI + CLI use could
// race on the same file and one operator could clobber the other. This store
// gives both paths a single, serialized writer with atomic semantics on top
// of the project's Storage abstraction.
//
// Concurrency contract: each instance serializes its own writes through a
// Promise-chain mutex. `upsert` / `remove` are read-modify-write; the mutex
// guarantees the read and the write are not interleaved with another
// upsert/remove on the same instance. Cross-process serialization is the
// underlying `writeAtomic`'s job — partial writes never appear at the
// destination path.
import { homedir } from 'node:os';
import { join } from 'node:path';
function defaultPath() {
    return join(homedir(), '.ethos', 'mcp.json');
}
export class McpJsonStore {
    storage;
    path;
    /** Mutex tail. Each operation chains onto this promise and updates it. */
    writeChain = Promise.resolve();
    constructor(storage, path = defaultPath()) {
        this.storage = storage;
        this.path = path;
    }
    /**
     * Read the current contents. Returns `[]` for missing or unparseable files.
     *
     * Two names — `read()` and `list()` — are kept as aliases. `read()` is the
     * mcp.service.ts vocabulary (matches `storage.read()`); `list()` is the
     * install-flow vocabulary (matches `manager.listServers()`).
     */
    async read() {
        const raw = await this.storage.read(this.path);
        if (!raw)
            return [];
        return parseEntries(raw);
    }
    /** Alias for `read()`. */
    async list() {
        return this.read();
    }
    /** Convenience: return one entry by name, or null if absent. */
    async get(name) {
        const entries = await this.read();
        return entries.find((e) => e.name === name) ?? null;
    }
    /**
     * Update-or-append by name. The `name` parameter is the lookup key; the
     * `config.name` field is what gets persisted. Pass them matching unless
     * you're intentionally renaming.
     */
    async upsert(name, config) {
        await this.serialize(async () => {
            const entries = await this.read();
            const idx = entries.findIndex((e) => e.name === name);
            if (idx === -1) {
                entries.push(config);
            }
            else {
                entries[idx] = config;
            }
            await this.writeAll(entries);
        });
    }
    /** Remove an entry by name. No-op if absent. */
    async remove(name) {
        await this.serialize(async () => {
            const entries = await this.read();
            const filtered = entries.filter((e) => e.name !== name);
            if (filtered.length === entries.length)
                return;
            await this.writeAll(filtered);
        });
    }
    async writeAll(entries) {
        const parent = dirOf(this.path);
        await this.storage.mkdir(parent);
        await this.storage.writeAtomic(this.path, `${JSON.stringify(entries, null, 2)}\n`);
    }
    serialize(op) {
        // Chain onto the existing tail so concurrent callers serialize. Always
        // restore the tail to a resolved Promise after this op completes so one
        // failure doesn't permanently poison the chain.
        const next = this.writeChain.then(op, op);
        this.writeChain = next.catch(() => { });
        return next;
    }
}
function parseEntries(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed;
    }
    catch {
        return [];
    }
}
function dirOf(path) {
    const slash = path.lastIndexOf('/');
    return slash === -1 ? '.' : path.slice(0, slash);
}
