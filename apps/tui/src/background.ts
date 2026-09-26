// C5 — the TUI's background-job completion box: the same content the readline
// branch prints (`backgroundCompletionLines` in apps/ethos/src/commands/
// chat.ts). REBUILT here rather than imported: that function lives in the CLI
// app, which this package must not depend on, so the two copies must change
// together. Only `done`/`failed` render; `aborted` is user-requested and
// stays silent. Pinned by __tests__/event-render.test.ts.

import type { BackgroundJob } from '@ethosagent/types';

export function backgroundCompletionLines(job: BackgroundJob): string[] | null {
  if (job.status !== 'done' && job.status !== 'failed') return null;
  const header = `bg:${job.id.slice(0, 8)}`;
  const statusLine = job.status === 'done' ? 'done' : `error: ${job.error ?? 'unknown'}`;
  const body = job.status === 'done' ? job.summary : undefined;
  const lines = [`╭─ background [${header}] ${statusLine}`];
  if (body) {
    for (const line of body.split('\n').slice(0, 10)) lines.push(`│ ${line}`);
    if (body.split('\n').length > 10) lines.push('│ ... (truncated)');
  }
  lines.push('╰─');
  return lines;
}
