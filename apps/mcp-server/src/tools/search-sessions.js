export async function searchSessions(sessionStore, query, limit, since, until) {
  const sinceBound = since ? new Date(since) : undefined;
  const untilBound = until ? new Date(until) : undefined;
  const sinceDate = sinceBound && !Number.isNaN(sinceBound.getTime()) ? sinceBound : undefined;
  const untilDate = untilBound && !Number.isNaN(untilBound.getTime()) ? untilBound : undefined;
  const results = await sessionStore.search(query, { limit, since: sinceDate, until: untilDate });
  return results.map((r) => ({
    sessionId: r.sessionId,
    messageId: r.messageId,
    snippet: r.snippet,
    score: r.score,
    timestamp: r.timestamp.toISOString(),
  }));
}
export const searchSessionsToolDef = {
  name: 'search_sessions',
  description: 'Full-text search across session messages',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query string',
      },
      limit: {
        type: 'number',
        description: 'Max results to return (default 10)',
      },
      since: {
        type: 'string',
        description: 'ISO-8601 lower bound (inclusive), e.g. "2026-05-01"',
      },
      until: {
        type: 'string',
        description: 'ISO-8601 upper bound (inclusive), e.g. "2026-05-20"',
      },
    },
    required: ['query'],
  },
};
