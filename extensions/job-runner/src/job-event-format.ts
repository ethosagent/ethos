import type { BackgroundJobEvent } from '@ethosagent/types';

const TEXT_LINE_CAP = 300;

function cap(s: string): string {
  return s.length > TEXT_LINE_CAP ? `${s.slice(0, TEXT_LINE_CAP - 1)}…` : s;
}

// `runner_log` payload is `{ lines: RunnerLogLine[] | string[], truncated?, dropped? }`
// (BackgroundExecutor's log flush, ./index.ts); one row per batch.
function runnerLogText(p: Record<string, unknown>): string {
  const lines = Array.isArray(p.lines) ? p.lines : [];
  const parts = lines.map((l: unknown) => {
    if (typeof l === 'string') return l;
    if (l && typeof l === 'object' && typeof (l as { line?: unknown }).line === 'string') {
      return (l as { line: string }).line;
    }
    return '';
  });
  if (typeof p.dropped === 'number' && p.dropped > 0) parts.push(`(+${p.dropped} dropped)`);
  if (p.truncated === true) parts.push('(truncated)');
  return parts.join(' | ').replace(/\s+/g, ' ').trim();
}

/**
 * One display line for a job event, for the gateway and CLI tails.
 *
 * DUPLICATES tools-delegation's private `formatEvent` (the `task_logs`
 * renderer) on purpose: tools-delegation must not import job-runner, so the
 * two cannot share one function. Merging them is a rule-5 cleanup candidate
 * (plan background-job-steer §10/§11). If the `text` collapse/cap rule changes,
 * change both.
 */
export function formatJobEventLine(ev: BackgroundJobEvent): string {
  const p = ev.payload;
  switch (ev.eventType) {
    case 'text': {
      const raw = typeof p.text === 'string' ? p.text : '';
      const flat = raw.replace(/\s+/g, ' ').trim();
      return `text: ${cap(flat)}`;
    }
    case 'tool_headline':
      return `tool: ${String(p.toolName ?? '?')}${typeof p.arg === 'string' && p.arg ? ` ${p.arg}` : ''}`;
    case 'tool_end':
      return `tool done: ${String(p.toolName ?? '?')} ${p.ok === false ? 'failed' : 'ok'}`;
    case 'steer':
      return `steer #${String(p.steerId ?? '?')} (${String(p.source ?? '?')}, ${String(p.chars ?? '?')} chars)`;
    case 'runner_log':
      return `log: ${cap(runnerLogText(p))}`;
    case 'artifact_change':
      return `artifact: ${cap(typeof p.path === 'string' ? p.path : JSON.stringify(p))}`;
    default:
      return ev.eventType;
  }
}
