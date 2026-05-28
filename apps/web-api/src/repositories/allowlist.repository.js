import { dirname, join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
export class AllowlistRepository {
    storage;
    path;
    writeChain = Promise.resolve();
    constructor(opts) {
        this.storage = opts.storage ?? new FsStorage();
        this.path = join(opts.dataDir, 'allowlist.json');
    }
    async list() {
        const file = await this.readSafe();
        return file.entries;
    }
    /**
     * Append a new entry. Concurrent calls serialise through `writeChain` so
     * two `add()` calls never trample one another's snapshot.
     */
    async add(entry) {
        this.writeChain = this.writeChain.then(async () => {
            const file = await this.readSafe();
            file.entries.push({ ...entry, createdAt: new Date().toISOString() });
            await this.persist(file);
        });
        await this.writeChain;
    }
    /** True when `toolName`+`args` are covered by an existing entry. */
    async matches(toolName, args) {
        const file = await this.readSafe();
        const argsKey = canonicalKey(args);
        for (const entry of file.entries) {
            if (entry.toolName !== toolName)
                continue;
            if (entry.scope === 'any-args')
                return true;
            if (entry.scope === 'exact-args' && canonicalKey(entry.args) === argsKey)
                return true;
        }
        return false;
    }
    async readSafe() {
        const raw = await this.storage.read(this.path);
        if (!raw)
            return { entries: [] };
        try {
            const parsed = JSON.parse(raw);
            return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
        }
        catch {
            return { entries: [] };
        }
    }
    async persist(file) {
        await this.storage.mkdir(dirname(this.path));
        await this.storage.writeAtomic(this.path, `${JSON.stringify(file, null, 2)}\n`);
    }
}
/**
 * Stable JSON serialisation: sort object keys recursively. Two args that
 * differ only in key ordering produce the same string, so an `exact-args`
 * allowlist match doesn't miss when the LLM reorders args between turns.
 */
function canonicalKey(value) {
    return JSON.stringify(sortKeys(value));
}
function sortKeys(value) {
    if (Array.isArray(value))
        return value.map(sortKeys);
    if (value && typeof value === 'object') {
        const out = {};
        for (const k of Object.keys(value).sort()) {
            out[k] = sortKeys(value[k]);
        }
        return out;
    }
    return value;
}
