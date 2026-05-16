import type { AfterTicketRevisionPayload, HookRegistry, MemoryProvider } from '@ethosagent/types';

export interface PostmortemHandlerOptions {
  teamName: string;
  memory: MemoryProvider;
  hooks: HookRegistry;
}

export function registerPostmortemHandler(opts: PostmortemHandlerOptions): () => void {
  const { teamName, memory, hooks } = opts;
  const ctx = {
    scopeId: `team:${teamName}`,
    sessionId: 'postmortem',
    sessionKey: 'postmortem',
    platform: 'system' as const,
    workingDir: '',
  };

  return hooks.registerVoid(
    'after_ticket_revision',
    async (payload: AfterTicketRevisionPayload) => {
      const shortId = payload.taskId.slice(0, 8);
      const key = `postmortems/${shortId}.md`;
      const content = [
        `# ${shortId} — needs revision`,
        '',
        `**Ticket:** ${payload.taskId}`,
        `**Assignee:** ${payload.assignee}`,
        `**Why it bounced:** ${payload.reason}`,
        '',
        `**Summary submitted:** ${payload.summary}`,
        ...(payload.acceptanceCriteria
          ? ['', `**Acceptance criteria:** ${payload.acceptanceCriteria}`]
          : []),
        '',
      ].join('\n');

      await memory.sync([{ action: 'replace', key, content }], ctx);
    },
  );
}
