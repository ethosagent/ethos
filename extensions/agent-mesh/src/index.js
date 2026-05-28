import { mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
const STALE_MS = 30_000;
const MAX_ENTRIES = 100;
const LOCK_TTL_MS = 5_000;
const LOCK_RETRY_MS = 10;
export function meshesDir() {
    return join(homedir(), '.ethos', 'meshes');
}
export function meshRegistryPath(meshName) {
    return join(meshesDir(), meshName, 'registry.json');
}
export function defaultRegistryPath() {
    return meshRegistryPath('default');
}
async function acquireRegistryLock(lockPath) {
    mkdirSync(dirname(lockPath), { recursive: true });
    const deadline = Date.now() + LOCK_TTL_MS;
    while (Date.now() < deadline) {
        try {
            writeFileSync(lockPath, '', { flag: 'wx' });
            return () => {
                try {
                    unlinkSync(lockPath);
                }
                catch {
                    /* already gone */
                }
            };
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
            // Stale lock detection: if the lock file is older than TTL, assume the holder crashed.
            try {
                const stat = statSync(lockPath);
                if (Date.now() - stat.mtimeMs > LOCK_TTL_MS) {
                    try {
                        unlinkSync(lockPath);
                    }
                    catch {
                        /* race: another holder already cleaned it up */
                    }
                    continue;
                }
            }
            catch {
                /* lock file disappeared between check and stat — retry immediately */
                continue;
            }
            await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
        }
    }
    throw new Error(`Failed to acquire registry lock at ${lockPath} within ${LOCK_TTL_MS}ms`);
}
export class AgentMesh {
    path;
    storage;
    constructor(registryPath = defaultRegistryPath(), opts = {}) {
        this.path = registryPath;
        this.storage = opts.storage ?? new FsStorage();
    }
    lockPath() {
        return this.path.replace(/\.json$/, '.lock');
    }
    async withLock(fn) {
        const release = await acquireRegistryLock(this.lockPath());
        try {
            return await fn();
        }
        finally {
            release();
        }
    }
    async read() {
        const src = await this.storage.read(this.path);
        if (!src)
            return [];
        try {
            return JSON.parse(src);
        }
        catch {
            return [];
        }
    }
    async write(entries) {
        const now = Date.now();
        const live = entries.filter((e) => now - e.lastHeartbeatAt < STALE_MS);
        // trim to hard cap — keep newest registered
        const capped = live.length > MAX_ENTRIES
            ? live.sort((a, b) => b.registeredAt - a.registeredAt).slice(0, MAX_ENTRIES)
            : live;
        await this.storage.mkdir(dirname(this.path));
        await this.storage.write(this.path, JSON.stringify(capped, null, 2));
    }
    async register(entry) {
        await this.withLock(async () => {
            const entries = await this.read();
            const now = Date.now();
            const idx = entries.findIndex((e) => e.agentId === entry.agentId);
            if (idx >= 0) {
                // preserve original registeredAt on re-registration
                entries[idx] = {
                    ...entry,
                    registeredAt: entries[idx].registeredAt,
                    lastHeartbeatAt: now,
                };
            }
            else {
                entries.push({ ...entry, registeredAt: now, lastHeartbeatAt: now });
            }
            await this.write(entries);
        });
    }
    async heartbeat(agentId, activeSessions) {
        await this.withLock(async () => {
            const entries = await this.read();
            const idx = entries.findIndex((e) => e.agentId === agentId);
            if (idx >= 0) {
                entries[idx] = { ...entries[idx], lastHeartbeatAt: Date.now(), activeSessions };
                await this.write(entries);
            }
        });
    }
    async unregister(agentId) {
        await this.withLock(async () => {
            const entries = await this.read();
            await this.write(entries.filter((e) => e.agentId !== agentId));
        });
    }
    // Returns least-busy live agent advertising the given capability.
    // Tie-break: lowest registeredAt (first registered wins).
    async route(capability) {
        const now = Date.now();
        const entries = await this.read();
        const candidates = entries
            .filter((e) => now - e.lastHeartbeatAt < STALE_MS)
            .filter((e) => e.capabilities.includes(capability));
        if (candidates.length === 0)
            return null;
        return (candidates.sort((a, b) => a.activeSessions !== b.activeSessions
            ? a.activeSessions - b.activeSessions
            : a.registeredAt - b.registeredAt)[0] ?? null);
    }
    async list() {
        const now = Date.now();
        const entries = await this.read();
        return entries.filter((e) => now - e.lastHeartbeatAt < STALE_MS);
    }
    // Starts a 10-second heartbeat. Returns a cleanup function. The async
    // heartbeat call is fire-and-forget — failures are swallowed; the next
    // tick retries.
    startHeartbeat(agentId, getActiveSessions) {
        const id = setInterval(() => {
            void this.heartbeat(agentId, getActiveSessions()).catch(() => { });
        }, 10_000);
        return () => clearInterval(id);
    }
}
export { appendMeshJournal, meshJournalPath, setMeshObservabilityService } from './journal';
