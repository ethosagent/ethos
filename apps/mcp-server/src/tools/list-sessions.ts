import type { SessionStore } from '@ethosagent/types';

export async function listSessions(
  sessionStore: SessionStore,
  limit: number,
): Promise<unknown[]> {
  const sessions = await sessionStore.listSessions({ limit });
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
    type: 'object' as const,
    properties: {
      limit: {
        type: 'number',
        description: 'Max sessions to return (default 20)',
      },
    },
  },
};
