import type { SessionStore } from '@ethosagent/types';

export async function getSession(
  sessionStore: SessionStore,
  id: string,
  messageLimit: number,
): Promise<{ error: string } | { session: unknown; messages: unknown[] }> {
  const session = await sessionStore.getSession(id);
  if (!session) {
    return { error: `Session not found: ${id}` };
  }

  const messages = await sessionStore.getMessages(id, { limit: messageLimit });

  return {
    session: {
      id: session.id,
      key: session.key,
      platform: session.platform,
      model: session.model,
      provider: session.provider,
      personalityId: session.personalityId,
      title: session.title,
      usage: session.usage,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      toolName: m.toolName,
      timestamp: m.timestamp.toISOString(),
    })),
  };
}

export const getSessionToolDef = {
  name: 'get_session',
  description: 'Get session metadata and first page of messages',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: {
        type: 'string',
        description: 'Session ID',
      },
      messageLimit: {
        type: 'number',
        description: 'Max messages to include (default 50)',
      },
    },
    required: ['id'],
  },
};
