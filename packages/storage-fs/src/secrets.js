import { dirname, join } from 'node:path';
/**
 * Reject refs that could escape the secrets directory or create ambiguous
 * paths. Throws with a descriptive message on violation.
 */
function validateRef(ref) {
    if (ref === '') {
        throw new Error('Secret ref must not be empty');
    }
    if (ref.includes('\0')) {
        throw new Error('Secret ref must not contain NUL bytes');
    }
    if (ref.includes('\\')) {
        throw new Error(`Secret ref must not contain backslashes: ${ref}`);
    }
    if (ref.startsWith('/') || /^[A-Za-z]:/.test(ref)) {
        throw new Error(`Secret ref must not be an absolute path: ${ref}`);
    }
    if (ref.split('/').some((seg) => seg === '..')) {
        throw new Error(`Secret ref must not contain "..": ${ref}`);
    }
    if (ref.split('/').some((seg) => seg === '')) {
        throw new Error(`Secret ref must not contain empty segments: ${ref}`);
    }
}
/**
 * File-backed SecretsResolver. Stores each secret as a plain-text file under
 * `opts.dir`, using the injected Storage for all I/O. File permissions are
 * set to 0o600 (owner-only read/write) via writeAtomic; the `opts.dir`
 * directory itself is tightened to 0o700 on every `set` so directory
 * listing (which refs are configured) doesn't leak on shared systems
 * regardless of the operator's umask.
 */
export class FileSecretsResolver {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    async get(ref) {
        validateRef(ref);
        const content = await this.opts.storage.read(join(this.opts.dir, ref));
        if (content === null)
            return null;
        return content.replace(/\n$/, '');
    }
    async set(ref, value) {
        validateRef(ref);
        const path = join(this.opts.dir, ref);
        await this.opts.storage.mkdir(dirname(path));
        await this.opts.storage.writeAtomic(path, `${value}\n`, { mode: 0o600 });
        // Idempotent dir-mode lockdown — applied on every set so first-write
        // and rotation both end with 0o700 on `opts.dir`. Tolerated to fail
        // silently on backends without POSIX permissions (in-memory tests
        // record the mode; real filesystems enforce it).
        await this.opts.storage.chmod(this.opts.dir, 0o700).catch(() => { });
    }
    async delete(ref) {
        validateRef(ref);
        await this.opts.storage.remove(join(this.opts.dir, ref)).catch((err) => {
            if (err.code !== 'ENOENT')
                throw err;
        });
    }
    async list(prefix) {
        const entries = await this.walkDir(this.opts.dir);
        const base = this.opts.dir.endsWith('/') ? this.opts.dir : `${this.opts.dir}/`;
        const refs = entries.map((e) => e.slice(base.length));
        if (!prefix)
            return refs;
        return refs.filter((r) => r.startsWith(prefix));
    }
    async walkDir(dir) {
        const entries = await this.opts.storage.listEntries(dir).catch(() => []);
        const result = [];
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDir) {
                result.push(...(await this.walkDir(fullPath)));
            }
            else {
                result.push(fullPath);
            }
        }
        return result;
    }
}
/**
 * In-memory SecretsResolver for tests. No filesystem, no validation overhead.
 */
export class InMemorySecretsResolver {
    store = new Map();
    async get(ref) {
        return this.store.get(ref) ?? null;
    }
    async set(ref, value) {
        this.store.set(ref, value);
    }
    async delete(ref) {
        this.store.delete(ref);
    }
    async list(prefix) {
        const all = [...this.store.keys()];
        if (!prefix)
            return all;
        return all.filter((r) => r.startsWith(prefix));
    }
}
