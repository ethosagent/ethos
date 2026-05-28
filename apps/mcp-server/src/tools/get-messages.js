export async function getMessages(sessionStore, sessionId, limit) {
  const messages = await sessionStore.getMessages(sessionId, { limit });
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    toolName: m.toolName,
    toolCallId: m.toolCallId,
    timestamp: m.timestamp.toISOString(),
  }));
}
export const getMessagesToolDef = {
  name: 'get_messages',
  description: 'Get messages from a session',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Session ID',
      },
      limit: {
        type: 'number',
        description: 'Max messages to return (default 50)',
      },
    },
    required: ['sessionId'],
  },
};
