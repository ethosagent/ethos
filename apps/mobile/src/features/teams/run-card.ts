import { formatDuration, type RunState, resolveRunner, runCardView } from '@ethosagent/chat-state';

// The run card in chat (D10, §3): runner badge from `RUNNERS`, the run label,
// the task line, a live `now` line, elapsed, and Stop run. The border colour
// is the state (no stripe, §12 amendment 16); the runner's teal is on the
// badge only. Live fields come from the `pi-run-reducer` state the chat store
// already folds `run.update` into and seeds from `tasks.list`.

export type RunBorder = 'border' | 'warning' | 'success' | 'error';

export interface RunCardModel {
  badge: string;
  /** The runner's teal, or null for a runner that is not a foreign process. */
  badgeColor: string | null;
  /** `Run · PI · run_7f3a` */
  header: string;
  /** The delegated prompt's label (`tasks.get`), when known. */
  title: string | null;
  nowLine: string;
  nowPulsing: boolean;
  /** `running · 41s` */
  statusLine: string;
  border: RunBorder;
  canStop: boolean;
}

const STATUS_WORD: Record<string, string> = {
  queued: 'queued',
  running: 'running',
  blocked: 'needs you',
  done: 'done',
  failed: 'failed',
  aborted: 'stopped',
  stale: 'stale',
};

export function runCardModel(run: RunState, title: string | null): RunCardModel {
  const runner = resolveRunner(run.runner);
  const view = runCardView(run.status);
  const border: RunBorder =
    view.border === 'subtle'
      ? 'border'
      : view.border === 'warning'
        ? 'warning'
        : view.border === 'success'
          ? 'success'
          : 'error';
  const nowLine =
    run.now ||
    (run.status === 'blocked'
      ? 'paused · waiting for you'
      : run.status === 'stale'
        ? 'no heartbeat'
        : '—');
  const shortId = run.jobId.length > 12 ? run.jobId.slice(0, 12) : run.jobId;
  return {
    badge: runner.badgeText,
    badgeColor: runner.accent?.dark ?? null,
    header: `Run · ${runner.badgeText} · ${shortId}`,
    title,
    nowLine,
    nowPulsing: view.pulsing,
    statusLine: `${STATUS_WORD[run.status] ?? run.status} · ${formatDuration(run.elapsedMs)}`,
    border,
    canStop: view.buttons.includes('cancel'),
  };
}
