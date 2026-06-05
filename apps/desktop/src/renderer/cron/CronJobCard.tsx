import { useState } from 'react';
import { Chip } from '../ui/Chip';
import { formatNextRun, getNextRun } from './utils/cron-next-run';

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  personalityId: string;
  deliver: string | null;
  status: 'active' | 'paused' | 'done';
  missedRunPolicy: 'run-once' | 'skip';
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

interface CronJobCardProps {
  job: CronJob;
  onSelect: (id: string) => void;
  onRunNow: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
  runningJobId: string | null;
}

export function CronJobCard({
  job,
  onSelect,
  onRunNow,
  onPause,
  onResume,
  onDelete,
  onEdit,
  runningJobId,
}: CronJobCardProps) {
  const [hovered, setHovered] = useState(false);
  const isRunning = runningJobId === job.id;
  const isPaused = job.status === 'paused';
  const nextRun = job.nextRunAt ? new Date(job.nextRunAt) : getNextRun(job.schedule);

  return (
    // biome-ignore lint/a11y/useSemanticElements: container holds nested buttons; cannot use <button>
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(job.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(job.id);
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
        padding: '14px 16px',
        cursor: 'pointer',
        opacity: isPaused && !hovered ? 0.75 : 1,
        transition: 'opacity 150ms var(--ease), border-color var(--motion-fast) var(--ease)',
        borderColor: hovered ? 'var(--border-strong, #3a3a3a)' : 'var(--border-subtle)',
      }}
    >
      {/* Row 1: name + badge + spacer + run now */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
          {job.name}
        </span>
        <Chip label={isPaused ? 'Paused' : 'Active'} variant={isPaused ? 'warning' : 'success'} />
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (!isRunning) onRunNow(job.id);
          }}
          disabled={isRunning}
          style={{
            background: 'none',
            border: '1px solid var(--border-strong, #3a3a3a)',
            borderRadius: 4,
            cursor: isRunning ? 'default' : 'pointer',
            fontSize: 11,
            color: isRunning ? 'var(--text-tertiary)' : 'var(--text-secondary)',
            padding: '2px 8px',
            transition:
              'color var(--motion-fast) var(--ease), border-color var(--motion-fast) var(--ease)',
          }}
          onMouseEnter={(e) => {
            if (!isRunning) {
              e.currentTarget.style.borderColor = 'var(--info, #4a9eff)';
              e.currentTarget.style.color = 'var(--info, #4a9eff)';
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--border-strong, #3a3a3a)';
            e.currentTarget.style.color = isRunning
              ? 'var(--text-tertiary)'
              : 'var(--text-secondary)';
          }}
        >
          {isRunning ? 'Running...' : 'Run now'}
        </button>
      </div>

      {/* Row 2: cron expression + personality + next run */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 8 }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-tertiary)',
          }}
        >
          {job.schedule}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--info, #4a9eff)',
          }}
        >
          {job.personalityId}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-tertiary)',
          }}
        >
          {isPaused ? 'Paused' : `Next: ${formatNextRun(nextRun)}`}
        </span>
      </div>

      {/* Row 3: description (prompt preview, 2-line clamp) */}
      {job.prompt ? (
        <div
          style={{
            marginTop: 6,
            fontSize: 12,
            color: 'var(--text-secondary)',
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {job.prompt}
        </div>
      ) : null}

      {/* Row 4: hover-reveal action row */}
      <div
        style={{
          display: hovered ? 'flex' : 'none',
          gap: 8,
          marginTop: 10,
        }}
      >
        <button
          type="button"
          title={isPaused ? 'Resume' : 'Pause'}
          onClick={(e) => {
            e.stopPropagation();
            isPaused ? onResume(job.id) : onPause(job.id);
          }}
          style={actionBtnStyle}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--text-secondary)';
          }}
        >
          {isPaused ? '▶' : '⏸'}
        </button>
        <button
          type="button"
          title="Edit"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(job.id);
          }}
          style={actionBtnStyle}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--text-secondary)';
          }}
        >
          &#x270E;
        </button>
        <button
          type="button"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(job.id);
          }}
          style={actionBtnStyle}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--error, #f87171)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--text-secondary)';
          }}
        >
          &#x1F5D1;
        </button>
      </div>
    </div>
  );
}

const actionBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: 14,
  color: 'var(--text-secondary)',
  padding: 0,
  lineHeight: 1,
  transition: 'color 80ms ease',
};
