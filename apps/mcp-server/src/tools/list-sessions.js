export async function listSessions(sessionStore, limit, since) {
    const sinceBound = since ? new Date(since) : undefined;
    const sinceDate = sinceBound && !Number.isNaN(sinceBound.getTime()) ? sinceBound : undefined;
    const sessions = await sessionStore.listSessions({ limit, since: sinceDate });
    return sessions.map((s) => ({
        id: s.id,
        key: s.key,
        platform: s.platform,
        model: s.model,
        provider: s.provider,
        personalityId: s.personalityId,
        title: s.title,
        usage: s.usage,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
    }));
}
export const listSessionsToolDef = {
    name: 'list_sessions',
    description: 'List recent sessions with metadata',
    inputSchema: {
        type: 'object',
        properties: {
            limit: {
                type: 'number',
                description: 'Max sessions to return (default 20)',
            },
            since: {
                type: 'string',
                description: 'ISO-8601 lower bound for session creation date, e.g. "2026-05-01"',
            },
        },
    },
};
