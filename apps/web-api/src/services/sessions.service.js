import { EthosError } from '@ethosagent/types';
import { exportFilename, formatAsMarkdown } from './sessions.export';
export class SessionsService {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    async list(input) {
        const limit = input.limit ?? 50;
        const page = await this.opts.sessions.list({
            ...(input.q !== undefined ? { q: input.q } : {}),
            limit,
            cursor: input.cursor ?? null,
            ...(input.personalityId ? { personalityId: input.personalityId } : {}),
        });
        return {
            items: page.sessions.map(toWireSession),
            nextCursor: page.nextCursor,
        };
    }
    async get(id) {
        const session = await this.opts.sessions.get(id);
        if (!session)
            throw notFound(id);
        const messages = await this.opts.sessions.messages(id);
        return {
            session: toWireSession(session),
            messages: messages.map(toWireMessage),
        };
    }
    async fork(id, personalityId) {
        try {
            const fresh = await this.opts.sessions.fork(id, personalityId);
            return { session: toWireSession(fresh) };
        }
        catch (err) {
            if (err instanceof Error && err.message.startsWith('session not found:')) {
                throw notFound(id);
            }
            throw err;
        }
    }
    async delete(id) {
        const exists = await this.opts.sessions.get(id);
        if (!exists)
            throw notFound(id);
        await this.opts.sessions.delete(id);
    }
    async export(id, _format) {
        const session = await this.opts.sessions.get(id);
        if (!session)
            throw notFound(id);
        const messages = await this.opts.sessions.messages(id);
        const wireSession = toWireSession(session);
        const wireMessages = messages.map(toWireMessage);
        const content = formatAsMarkdown(wireSession, wireMessages);
        const filename = exportFilename(wireSession.title, wireSession.createdAt);
        return { content, filename };
    }
    async update(id, patch) {
        try {
            await this.opts.sessions.update(id, patch);
        }
        catch (err) {
            if (err instanceof Error && err.message.startsWith('session not found:')) {
                throw notFound(id);
            }
            throw err;
        }
        const session = await this.opts.sessions.get(id);
        if (!session)
            throw notFound(id);
        return { session: toWireSession(session) };
    }
    async pin(id) {
        const exists = await this.opts.sessions.get(id);
        if (!exists)
            throw notFound(id);
        await this.opts.sessions.update(id, { pinned: true });
        const session = await this.opts.sessions.get(id);
        if (!session)
            throw notFound(id);
        return { session: toWireSession(session) };
    }
    async unpin(id) {
        const exists = await this.opts.sessions.get(id);
        if (!exists)
            throw notFound(id);
        await this.opts.sessions.update(id, { pinned: false });
        const session = await this.opts.sessions.get(id);
        if (!session)
            throw notFound(id);
        return { session: toWireSession(session) };
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function notFound(id) {
    return new EthosError({
        code: 'SESSION_NOT_FOUND',
        cause: `Session ${id} not found`,
        action: 'Verify the ID. Open the Sessions tab to see the current list.',
    });
}
function toWireSession(s) {
    return {
        id: s.id,
        key: s.key,
        platform: s.platform,
        model: s.model,
        provider: s.provider,
        personalityId: s.personalityId ?? null,
        parentSessionId: s.parentSessionId ?? null,
        workingDir: s.workingDir ?? null,
        title: s.title ?? null,
        pinned: s.pinned ?? false,
        usage: s.usage,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
        version: 1,
    };
}
function toWireMessage(m) {
    return {
        id: m.id,
        sessionId: m.sessionId,
        role: m.role,
        content: m.content,
        toolCallId: m.toolCallId ?? null,
        toolName: m.toolName ?? null,
        toolCalls: m.toolCalls ?? null,
        timestamp: m.timestamp.toISOString(),
    };
}
