// Shared goal status presentation + time/number formatting for the desktop
// goals surface. Mirrors the web STATUS_CONFIG so the two surfaces read the
// same; kept in one module so the list, card and detail views agree.

export interface StatusConfig {
  color: string;
  label: string;
  icon: string;
}

export const STATUS_CONFIG: Record<string, StatusConfig> = {
  running: { color: 'var(--info)', label: 'Running', icon: '⏳' },
  judging: { color: 'var(--info)', label: 'Judging', icon: '⏳' },
  retrying: { color: 'var(--info)', label: 'Retrying', icon: '⏳' },
  needs_clarification: { color: 'var(--warning)', label: 'Needs Input', icon: '⏳' },
  completed: { color: 'var(--success)', label: 'Completed', icon: '✓' },
  failed: { color: 'var(--error)', label: 'Failed', icon: '✗' },
  cancelled: { color: 'var(--text-tertiary)', label: 'Cancelled', icon: '—' },
  interrupted: { color: 'var(--warning)', label: 'Interrupted', icon: '✗' },
  exhausted: { color: 'var(--warning)', label: 'Exhausted', icon: '✗' },
};

export const ACTIVE_STATUSES = new Set(['running', 'judging', 'retrying', 'needs_clarification']);

export const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'exhausted',
]);

export function statusConfig(status: string): StatusConfig {
  return STATUS_CONFIG[status] ?? { color: 'var(--text-secondary)', label: status, icon: '?' };
}

export function formatDuration(startedAt: number, completedAt: number | null): string {
  const end = completedAt ?? Date.now();
  const ms = end - startedAt;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatTokens(n: number | null): string {
  if (n == null) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
