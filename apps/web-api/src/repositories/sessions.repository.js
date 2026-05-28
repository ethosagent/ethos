export class SessionsRepository {
    store;
    constructor(store) {
        this.store = store;
    }
    async list(opts) {
        if (opts.q?.trim()) {
            // store.search() uses a phrase-quoted FTS5 query, so multi-word queries
            // require per-term searches intersected by sessionId. Single-word queries
            // go through as-is.
            const terms = opts.q.trim().split(/\s+/).filter(Boolean);
            // Use a large internal limit so the intersection isn't artificially
            // truncated — a session that matches all terms might rank outside the
            // top opts.limit results for a single term.
            const termLimit = Math.max(opts.limit * 10, 100);
            const termResults = await Promise.all(terms.map((t) => this.store.search(t, { limit: termLimit })));
            // Build a set of session IDs that appear in ALL term result sets.
            const sets = termResults.map((rs) => new Set(rs.map((r) => r.sessionId)));
            const [firstSet, ...restSets] = sets;
            const intersected = firstSet
                ? [...firstSet].filter((id) => restSets.every((s) => s.has(id)))
                : [];
            // Apply the caller's limit after intersection.
            const matchedIds = intersected.slice(0, opts.limit);
            const sessions = (await Promise.all(matchedIds.map((id) => this.store.getSession(id)))).filter((s) => s !== null);
            return { sessions, nextCursor: null };
        }
        const offset = decodeCursor(opts.cursor);
        const filter = {
            limit: opts.limit + 1,
            offset,
        };
        if (opts.personalityId)
            filter.personalityId = opts.personalityId;
        const rows = await this.store.listSessions(filter);
        const more = rows.length > opts.limit;
        const sessions = more ? rows.slice(0, opts.limit) : rows;
        const nextCursor = more ? encodeCursor(offset + opts.limit) : null;
        return { sessions, nextCursor };
    }
    async get(id) {
        return this.store.getSession(id);
    }
    async getByKey(key) {
        return this.store.getSessionByKey(key);
    }
    /**
     * Create a fresh session row. The agent loop will see this row when
     * `bridge.send(...)` runs (matched by `key`) instead of lazy-creating
     * one of its own — so the sessionId we return from `chat.send` is the
     * same row that ends up holding the conversation.
     */
    async create(input) {
        return this.store.createSession({
            key: input.key,
            platform: input.platform,
            model: input.model,
            provider: input.provider,
            ...(input.personalityId ? { personalityId: input.personalityId } : {}),
            ...(input.workingDir ? { workingDir: input.workingDir } : {}),
            usage: zeroUsage(),
        });
    }
    async messages(sessionId, limit) {
        const opts = limit !== undefined ? { limit } : undefined;
        return this.store.getMessages(sessionId, opts);
    }
    async delete(id) {
        return this.store.deleteSession(id);
    }
    async update(id, patch) {
        const exists = await this.store.getSession(id);
        if (!exists)
            throw new Error(`session not found: ${id}`);
        const updatePatch = {};
        if (patch.title !== undefined) {
            updatePatch.title = patch.title;
        }
        if (patch.pinned !== undefined) {
            updatePatch.pinned = patch.pinned;
        }
        await this.store.updateSession(id, updatePatch);
    }
    async search(query, limit = 20) {
        return this.store.search(query, { limit });
    }
    /**
     * Create a new session that copies the source's shape (model / provider /
     * platform / personality) and replays its messages. The new session's
     * `parentSessionId` points at the source so the UI can surface the lineage.
     */
    async fork(sourceId, personalityOverride) {
        const source = await this.store.getSession(sourceId);
        if (!source)
            return Promise.reject(new Error(`session not found: ${sourceId}`));
        const fresh = await this.store.createSession({
            key: `${source.key}:fork:${Date.now()}`,
            platform: source.platform,
            model: source.model,
            provider: source.provider,
            ...(personalityOverride
                ? { personalityId: personalityOverride }
                : source.personalityId
                    ? { personalityId: source.personalityId }
                    : {}),
            parentSessionId: source.id,
            ...(source.workingDir ? { workingDir: source.workingDir } : {}),
            ...(source.title ? { title: source.title } : {}),
            usage: zeroUsage(),
            ...(source.metadata ? { metadata: source.metadata } : {}),
        });
        // Replay the source's history into the fork. Preserves tool_use / tool_result
        // pairing because we copy in chronological order.
        const history = await this.store.getMessages(source.id);
        for (const msg of history) {
            await this.store.appendMessage({
                sessionId: fresh.id,
                role: msg.role,
                content: msg.content,
                ...(msg.toolCallId ? { toolCallId: msg.toolCallId } : {}),
                ...(msg.toolName ? { toolName: msg.toolName } : {}),
                ...(msg.toolCalls ? { toolCalls: msg.toolCalls } : {}),
                ...(msg.usage ? { usage: msg.usage } : {}),
            });
        }
        return fresh;
    }
}
function zeroUsage() {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        apiCallCount: 0,
        compactionCount: 0,
    };
}
function encodeCursor(offset) {
    return Buffer.from(String(offset), 'utf-8').toString('base64url');
}
function decodeCursor(cursor) {
    if (!cursor)
        return 0;
    try {
        const n = Number(Buffer.from(cursor, 'base64url').toString('utf-8'));
        return Number.isFinite(n) && n >= 0 ? n : 0;
    }
    catch {
        return 0;
    }
}
