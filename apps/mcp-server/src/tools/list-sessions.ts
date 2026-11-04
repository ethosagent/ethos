import type { SessionStore } from '@ethosagent/types';
import { isIncognitoSession } from '@ethosagent/wiring';

export async function listSessions(
  sessionStore: SessionStore,
  limit: number,
  since?: string,
): Promise<unknown[]> {
  const sinceBound = since ? new Date(since) : undefined;
  const sinceDate = sinceBound && !Number.isNaN(sinceBound.getTime()) ? sinceBound : undefined;
  const sessions = await sessionStore.listSessions({ limit, since: sinceDate });
  // D11 (plan incognito-sessions): incognito sessions are never handed to an external client.
  return sessions
    .filter((s) => !isIncognitoSession(s))
    .map((s) => ({
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
      since: {
        type: 'string',
        description: 'ISO-8601 lower bound for session creation date, e.g. "2026-05-01"',
      },
    },
  },
};
