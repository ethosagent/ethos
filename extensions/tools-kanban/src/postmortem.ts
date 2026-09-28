import type { AfterTicketRevisionPayload, HookRegistry, MemoryProvider } from '@ethosagent/types';

export interface PostmortemHandlerOptions {
  teamName: string;
  memory: MemoryProvider;
  hooks: HookRegistry;
  /**
   * Whether the task was stamped shared (`Task.roomAudience`, plan
   * personality-memory-boundary D20). A shared task's summary and criteria
   * came from a room, and team memory is not the room's (D4(a)), so its
   * postmortem is not written (verification round B17). Wired by
   * `composeAllTools` (packages/wiring/src/compose-tools.ts) over the kanban
   * store; absent → every postmortem is written, as before.
   */
  isSharedTask?: (taskId: string) => boolean;
}

export function registerPostmortemHandler(opts: PostmortemHandlerOptions): () => void {
  const { teamName, memory, hooks, isSharedTask } = opts;
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
      if (isSharedTask?.(payload.taskId)) return;
      // Flat key, no `/`: memory keys are file names within the scope dir and
      // path separators are rejected by the provider.
      const key = `postmortem-${payload.taskId}.md`;
      const shortId = payload.taskId.slice(0, 8);
      const content = [
        `# ${shortId} — needs revision`,
        '',
        `**Ticket:** ${payload.taskId}`,
        `**Assignee:** ${payload.assignee}`,
        ...(payload.autonomyTier
          ? [`**Tier:** ${payload.autonomyTier} (ratio ${(payload.successRatio ?? 0).toFixed(2)})`]
          : []),
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
