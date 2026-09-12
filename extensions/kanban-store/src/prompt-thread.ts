import type { TaskComment, TaskRun } from './index';

/** Author prefix the operator surfaces stamp on comments (`human:control-center`, `human:<label>`). */
const HUMAN_AUTHOR_PREFIX = 'human:';
/** Most recent operator comments carried into a prompt. */
const MAX_OPERATOR_COMMENTS = 10;
/** Character budget for the rendered operator comments; the oldest are dropped first. */
const MAX_OPERATOR_CHARS = 4_000;
const TRUNCATION_MARKER = '… [truncated]';

/**
 * Render what an operator has told the agent about a task since it was created,
 * for appending to a (re-)dispatch prompt. Each claim runs in a fresh session,
 * so without this an agent unblocked by an operator's answer never sees the
 * answer — it restarts from scratch, reaches the same checkpoint and blocks
 * again with the same question.
 *
 * Carries two things: the summary of the most recent ENDED run when that run
 * ended `blocked` (the question or reason it stopped on — `blockRun` writes it
 * to the run's `summary`), and the comments authored by a `human:*` actor,
 * oldest first, capped at `MAX_OPERATOR_COMMENTS` and `MAX_OPERATOR_CHARS`
 * (oldest dropped first, with a note saying how many). Agent-authored comments
 * — the tool-call echoes `writeRunActivityComments` writes, the agent's own
 * block reason — are excluded. Returns `''` when there is nothing to add.
 */
export function renderOperatorContext(comments: TaskComment[], runs: TaskRun[]): string {
  let lastEnded: TaskRun | undefined;
  for (const run of runs) {
    if (run.endedAt === null) continue;
    if (lastEnded === undefined || run.endedAt >= (lastEnded.endedAt ?? 0)) lastEnded = run;
  }
  const blockedSummary =
    lastEnded?.outcome === 'blocked' && lastEnded.summary ? lastEnded.summary : null;

  const human = comments
    .filter((c) => c.author.startsWith(HUMAN_AUTHOR_PREFIX))
    .sort((a, b) => a.createdAt - b.createdAt);
  const entries = human.slice(-MAX_OPERATOR_COMMENTS).map(formatComment);
  let omitted = human.length - entries.length;
  let total = entries.reduce((n, e) => n + e.length, 0);
  while (entries.length > 1 && total > MAX_OPERATOR_CHARS) {
    total -= entries.shift()?.length ?? 0;
    omitted++;
  }
  // A single comment over budget on its own is cut rather than dropped — it is
  // the newest one, the likeliest to hold the answer.
  const only = entries.length === 1 ? entries[0] : undefined;
  if (only !== undefined && only.length > MAX_OPERATOR_CHARS) {
    entries[0] = `${only.slice(0, MAX_OPERATOR_CHARS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
  }

  if (blockedSummary === null && entries.length === 0) return '';

  const lines = ['## Operator context', ''];
  if (blockedSummary !== null) {
    lines.push(`Your previous attempt stopped with: ${blockedSummary}`, '');
  }
  if (entries.length > 0) {
    lines.push('Operator comments on this task (oldest first):');
    if (omitted > 0) {
      lines.push(`(${omitted} earlier operator comment${omitted === 1 ? '' : 's'} omitted)`);
    }
    lines.push(...entries, '');
    lines.push(
      'Operator comments above answer earlier questions — act on them; do not ask again for what they already answered.',
    );
  }
  return lines.join('\n').trimEnd();
}

function formatComment(c: TaskComment): string {
  const body = c.body.trim().replace(/\n/g, '\n  ');
  return `- [${new Date(c.createdAt).toISOString()}] ${c.author}: ${body}`;
}
