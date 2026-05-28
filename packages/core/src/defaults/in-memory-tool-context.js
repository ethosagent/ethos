class InMemoryKeyValueStore {
    data = new Map();
    async get(key) {
        const entry = this.data.get(key);
        if (!entry)
            return null;
        if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
            this.data.delete(key);
            return null;
        }
        return entry.value;
    }
    async set(key, value, opts) {
        const expiresAt = opts?.ttlSeconds ? Date.now() + opts.ttlSeconds * 1_000 : undefined;
        this.data.set(key, { value, expiresAt });
    }
    async delete(key) {
        this.data.delete(key);
    }
    async list(prefix) {
        return [...this.data.keys()].filter((k) => k.startsWith(prefix));
    }
}
export function makeTestToolContext(opts) {
    const ctx = {
        sessionId: opts?.sessionId ?? 'test-session',
        sessionKey: opts?.sessionKey ?? 'cli:test',
        platform: opts?.platform ?? 'cli',
        workingDir: opts?.workingDir ?? '/tmp',
        personalityId: opts?.personalityId,
        currentTurn: opts?.currentTurn ?? 1,
        messageCount: opts?.messageCount ?? 1,
        abortSignal: new AbortController().signal,
        emit: () => { },
        resultBudgetChars: opts?.resultBudgetChars ?? 80_000,
    };
    if (opts?.withStorage) {
        ctx.kvStore = new InMemoryKeyValueStore();
    }
    return ctx;
}
