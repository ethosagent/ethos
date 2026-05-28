import type { SessionStore } from '@ethosagent/types';

/**
 * Subset of AgentDonePayload used by the fork-context builder.
 * Kept minimal so this module doesn't break if the payload type evolves.
 */
interface ForkPayload {
  sessionId: string;
  toolNames?: string[];
  activeSkillFiles?: string[];
}

/**
 * Build a compact text transcript from the most-recent session messages,
 * suitable for feeding into the skill-evolution improvement fork.
 *
 * Filters out tool_result / system / user_steer messages — keeps only
 * user and assistant turns — and prepends a brief metadata header with
 * the tools and skills that were active during the session.
 */
export async function buildForkContext(
  payload: ForkPayload,
  sessionStore: SessionStore,
): Promise<string> {
  const messages = await sessionStore.getMessages(payload.sessionId, { limit: 20 });

  const relevant = messages.filter((m) => m.role === 'user' || m.role === 'assistant');

  const transcript = relevant
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${truncate(String(m.content), 600)}`)
    .join('\n\n');

  const toolSummary = payload.toolNames?.length
    ? `Tools used: ${payload.toolNames.join(', ')}`
    : '';
  const skillSummary = payload.activeSkillFiles?.length
    ? `Active skills: ${payload.activeSkillFiles.join(', ')}`
    : '';

  return ['## Turn summary', toolSummary, skillSummary, '', '## Transcript', transcript]
    .filter(Boolean)
    .join('\n');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}
