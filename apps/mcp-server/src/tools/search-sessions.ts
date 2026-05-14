import type { SessionStore } from '@ethosagent/types';

export async function searchSessions(
  sessionStore: SessionStore,
  query: string,
  limit: number,
): Promise<unknown[]> {
  const results = await sessionStore.search(query, { limit });
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
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Search query string',
      },
      limit: {
        type: 'number',
        description: 'Max results to return (default 10)',
      },
    },
    required: ['query'],
  },
};
