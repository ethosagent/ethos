import { buildWorkspaceChatPath } from '../lib/workspaceRoutes';

// First-task suggestions (plan keyless-first-run §4.2, D16/D17). Static strings
// chosen by what is true. Choosing one PREFILLS the chat composer through the
// existing `?draft=` hand-off in `pages/Chat.tsx` (the user still presses Send).
// Nothing here ever reaches a prompt: no injector, no system-prompt text.

export const FIRST_TASK_LOOK_AROUND = 'Look around this folder and tell me what it is.';
export const FIRST_TASK_DEEPWIKI = 'Ask DeepWiki how <owner/repo> handles errors.';
export const FIRST_TASK_PLAN_WEEK = 'Help me plan my week. Ask me three questions first.';

/** One line per connected OAuth preset; the copy is kept here, keyed by preset name. */
export const OAUTH_FIRST_TASKS: Readonly<Record<string, string>> = {
  linear: 'Show my open issues.',
  notion: 'Find the Notion pages I edited most recently.',
  sentry: 'What are my top unresolved Sentry issues?',
  asana: 'List my Asana tasks due this week.',
  vercel: 'Show my latest Vercel deployments.',
  granola: 'Summarize my most recent meeting.',
};

export const MAX_FIRST_TASKS = 4;

/**
 * Up to four suggestions. The first and last are always present; DeepWiki and
 * the OAuth lines appear only for presets that actually connected. When more
 * than two connected lines qualify, the extras are dropped so "plan my week"
 * stays last.
 */
export function firstTaskSuggestions(connected: readonly string[]): string[] {
  const middle: string[] = [];
  if (connected.includes('deepwiki')) middle.push(FIRST_TASK_DEEPWIKI);
  for (const name of connected) {
    const line = OAUTH_FIRST_TASKS[name];
    if (line) middle.push(line);
  }
  return [FIRST_TASK_LOOK_AROUND, ...middle.slice(0, MAX_FIRST_TASKS - 2), FIRST_TASK_PLAN_WEEK];
}

/** The chat route that opens with `text` in the composer (D17: prefill, never send). */
export function firstTaskChatPath(personalityId: string, text: string): string {
  return `${buildWorkspaceChatPath(personalityId)}?draft=${encodeURIComponent(text)}`;
}
